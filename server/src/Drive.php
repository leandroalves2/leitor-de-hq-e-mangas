<?php

declare(strict_types=1);

final class Drive
{
    private static function decode(string $s): string
    {
        return trim(html_entity_decode(strip_tags($s), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }

    public static function parseLink(string $link): ?array
    {
        $link = trim($link);
        if (preg_match('#/folders/([\w-]{10,})#', $link, $m) || preg_match('#folderview\?id=([\w-]{10,})#', $link, $m)) {
            return ['type' => 'folder', 'id' => $m[1]];
        }
        if (preg_match('#/file/d/([\w-]{10,})#', $link, $m) || preg_match('#[?&]id=([\w-]{10,})#', $link, $m) || preg_match('#/d/([\w-]{10,})#', $link, $m)) {
            return ['type' => 'file', 'id' => $m[1]];
        }
        if (preg_match('#^[\w-]{20,}$#', $link)) {
            return ['type' => 'folder', 'id' => $link];
        }
        return null;
    }

    public static function parseFolderHtml(string $html): array
    {
        $items = [];
        if (preg_match_all('#<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([\s\S]*?)</div>#', $html, $all, PREG_SET_ORDER)) {
            foreach ($all as $m) {
                $items[] = ['id' => $m[1], 'name' => self::decode($m[3]), 'folder' => str_contains(html_entity_decode($m[2]), '/folders/')];
            }
        }
        $title = preg_match('#<title>([\s\S]*?)</title>#i', $html, $t) ? preg_replace('#\s*-\s*Google Drive\s*$#i', '', self::decode($t[1])) : '';
        return ['title' => (string) $title, 'items' => $items];
    }

    public static function parseFileTitle(string $html): string
    {
        if (preg_match('#<meta property="og:title" content="([^"]*)"#i', $html, $m)) {
            return self::decode($m[1]);
        }
        if (preg_match('#<title>([\s\S]*?)</title>#i', $html, $m)) {
            return (string) preg_replace('#\s*-\s*Google Drive\s*$#i', '', self::decode($m[1]));
        }
        return '';
    }

    public static function parseConfirmForm(string $html): ?string
    {
        if (!preg_match('#<form[^>]+id="download-form"[^>]*action="([^"]+)"[\s\S]*?</form>#i', $html, $form)) {
            return null;
        }
        $params = [];
        if (preg_match_all('#<input[^>]+type="hidden"[^>]*>#i', $form[0], $inputs)) {
            foreach ($inputs[0] as $input) {
                if (preg_match('#name="([^"]+)"#', $input, $n)) {
                    $params[html_entity_decode($n[1])] = preg_match('#value="([^"]*)"#', $input, $v) ? html_entity_decode($v[1]) : '';
                }
            }
        }
        return html_entity_decode($form[1]) . '?' . http_build_query($params);
    }

    private static function supported(string $name): bool
    {
        return Library::kind($name) !== null;
    }

    private static function listPublicTree(string $rootId, array &$out, array &$job, callable $tick): void
    {
        $level = [['id' => $rootId, 'rel' => '']];
        $folders = 0;
        for ($depth = 0; $depth <= 4 && $level; $depth++) {
            $queue = [];
            foreach ($level as $i => $folder) {
                $queue[] = ['key' => $i, 'url' => 'https://drive.google.com/embeddedfolderview?id=' . rawurlencode($folder['id']), 'rel' => $folder['rel']];
            }
            $next = [];
            $fatal = null;
            Net::multi($queue, 8, static function (array $req, array $res) use (&$out, &$job, &$next, &$fatal, &$folders, $depth, $tick): ?array {
                $folders++;
                if ($res['error'] !== '' || $res['status'] >= 400) {
                    $message = $res['error'] !== '' ? $res['error'] : 'O Google Drive respondeu ' . $res['status'] . '. A pasta está compartilhada como "qualquer pessoa com o link"?';
                    if ($depth === 0) {
                        $fatal = $message;
                    } else {
                        $job['errors'][] = ($req['rel'] !== '' ? $req['rel'] . ': ' : '') . $message;
                    }
                    return null;
                }
                $parsed = self::parseFolderHtml((string) $res['body']);
                if ($depth === 0 && $parsed['title'] !== '') {
                    $job['title'] = $parsed['title'];
                }
                foreach ($parsed['items'] as $item) {
                    $rel = $req['rel'] === '' ? $item['name'] : $req['rel'] . '/' . $item['name'];
                    if ($item['folder']) {
                        if ($depth < 4) {
                            $next[] = ['id' => $item['id'], 'rel' => $rel];
                        }
                    } elseif (self::supported($item['name'])) {
                        $out[] = ['id' => $item['id'], 'name' => $item['name'], 'rel' => $req['rel'], 'source' => 'public', 'size' => 0];
                    } else {
                        $job['skipped']++;
                    }
                }
                $job['files'] = count($out);
                $tick($folders);
                return null;
            });
            if ($fatal !== null) {
                throw new RuntimeException($fatal);
            }
            $level = $next;
        }
        usort($out, static fn(array $a, array $b): int => strnatcasecmp($a['rel'] . '/' . $a['name'], $b['rel'] . '/' . $b['name']));
    }

    private static function itemRequest(array $item, ?string $token): array
    {
        if ($item['source'] === 'account') {
            return [
                'url' => 'https://www.googleapis.com/drive/v3/files/' . rawurlencode($item['id']) . '?alt=media&supportsAllDrives=true',
                'headers' => ['Authorization: Bearer ' . $token],
            ];
        }
        return ['url' => 'https://drive.usercontent.google.com/download?id=' . rawurlencode($item['id']) . '&export=download&confirm=t', 'headers' => []];
    }

    private static function analyze(array &$items, array &$job, callable $touch, callable $cancelled): void
    {
        $started = microtime(true);
        $token = null;
        foreach ($items as $item) {
            if ($item['source'] === 'account') {
                $token = Google::token();
                break;
            }
        }
        $unknown = [];
        foreach ($items as $i => $item) {
            if ($item['size'] <= 0) {
                $unknown[] = $i;
            }
        }
        $sampleMax = 40;
        $sample = $unknown;
        if (count($unknown) > $sampleMax) {
            $sample = [];
            $step = count($unknown) / $sampleMax;
            for ($k = 0; $k < $sampleMax; $k++) {
                $sample[] = $unknown[(int) floor($k * $step)];
            }
        }
        $job['current'] = 'Medindo o tamanho das HQs';
        $touch(true);
        if ($sample) {
            $queue = [];
            foreach ($sample as $i) {
                $queue[] = ['key' => $i, 'range' => '0-0', 'cap' => 65536] + self::itemRequest($items[$i], $token);
            }
            Net::multi($queue, 10, static function (array $req, array $res) use (&$items): ?array {
                $size = 0;
                $type = $res['headers']['content-type'] ?? '';
                if (!str_contains($type, 'text/html') && $res['status'] < 400) {
                    if (preg_match('#/(\d+)\s*$#', $res['headers']['content-range'] ?? '', $m)) {
                        $size = (int) $m[1];
                    } elseif ($res['status'] === 200) {
                        $size = (int) ($res['headers']['content-length'] ?? 0);
                    }
                }
                if ($size > 0) {
                    $items[$req['key']]['size'] = $size;
                    $items[$req['key']]['probed'] = true;
                }
                return null;
            }, static fn(array $bytes): bool => !$cancelled());
        }
        $known = 0;
        $knownCount = 0;
        foreach ($items as $item) {
            if ($item['size'] > 0) {
                $known += $item['size'];
                $knownCount++;
            }
        }
        $average = $knownCount > 0 ? $known / $knownCount : 0;
        $total = 0;
        $estimated = false;
        foreach ($items as $i => $item) {
            if ($item['size'] > 0) {
                $total += $item['size'];
            } else {
                $total += (int) $average;
                $estimated = true;
            }
        }
        $job['totalBytes'] = (int) $total;
        $job['estimated'] = $estimated;
        $job['avgBytes'] = (int) $average;
        $job['speed'] = self::measureSpeed($items, $token, $cancelled);
        $job['eta'] = $job['speed'] > 0 ? (int) ceil($total / $job['speed']) : null;
        $job['analyzedIn'] = round(microtime(true) - $started, 1);
        $job['analyzed'] = true;
    }

    private static function measureSpeed(array $items, ?string $token, callable $cancelled): float
    {
        $queue = [];
        foreach ($items as $i => $item) {
            if (($item['size'] ?? 0) > 1048576) {
                $queue[] = ['key' => $i, 'range' => '0-4194303', 'discard' => true] + self::itemRequest($item, $token);
                if (count($queue) >= 3) {
                    break;
                }
            }
        }
        if (!$queue) {
            return 0.0;
        }
        $start = microtime(true);
        $bytes = 0;
        $finished = 0;
        Net::multi($queue, 3, static function (array $req, array $res) use (&$bytes, &$finished): ?array {
            $finished += $res['bytes'];
            $bytes = max($bytes, $finished);
            return null;
        }, static function (array $now) use ($start, &$bytes, &$finished, $cancelled): bool {
            $bytes = max($bytes, $finished + array_sum($now));
            return !$cancelled() && microtime(true) - $start < 4.0;
        });
        $elapsed = microtime(true) - $start;
        return $elapsed > 0.2 && $bytes > 0 ? $bytes / $elapsed : 0.0;
    }

    public static function listAccount(string $folder): array
    {
        $token = Google::token();
        $folder = preg_match('#^[\w-]+$#', $folder) ? $folder : 'root';
        $items = [];
        $page = '';
        do {
            $query = http_build_query([
                'q' => "'" . $folder . "' in parents and trashed = false",
                'fields' => 'nextPageToken, files(id, name, mimeType, size)',
                'pageSize' => 1000,
                'orderBy' => 'folder,name_natural',
                'supportsAllDrives' => 'true',
                'includeItemsFromAllDrives' => 'true',
                'pageToken' => $page,
            ]);
            $res = Net::json('GET', 'https://www.googleapis.com/drive/v3/files?' . $query, ['Authorization: Bearer ' . $token]);
            if ($res['status'] >= 400) {
                throw new HttpError(502, 'Erro do Google Drive: ' . ($res['data']['error']['message'] ?? $res['status']));
            }
            foreach ($res['data']['files'] ?? [] as $f) {
                $isFolder = ($f['mimeType'] ?? '') === 'application/vnd.google-apps.folder';
                if (!$isFolder && !self::supported((string) $f['name'])) {
                    continue;
                }
                $items[] = ['id' => $f['id'], 'name' => $f['name'], 'folder' => $isFolder, 'size' => (int) ($f['size'] ?? 0)];
            }
            $page = (string) ($res['data']['nextPageToken'] ?? '');
        } while ($page !== '');
        return ['folder' => $folder, 'items' => $items];
    }

    private static function listAccountTree(string $id, string $rel, int $depth, array &$out, ?callable $tick = null): void
    {
        if ($tick !== null) {
            $tick($rel);
        }
        foreach (self::listAccount($id)['items'] as $item) {
            if ($item['folder']) {
                if ($depth < 6) {
                    self::listAccountTree($item['id'], $rel === '' ? $item['name'] : $rel . '/' . $item['name'], $depth + 1, $out, $tick);
                }
            } else {
                $out[] = ['id' => $item['id'], 'name' => $item['name'], 'rel' => $rel, 'source' => 'account', 'size' => $item['size']];
            }
        }
    }

    private static function jobsDir(): string
    {
        return Config::storage('jobs');
    }

    private static function jobFile(string $id): string
    {
        if (!preg_match('/^j[a-f0-9]{16}$/', $id)) {
            throw new HttpError(400, 'Download inválido');
        }
        return self::jobsDir() . DIRECTORY_SEPARATOR . $id . '.json';
    }

    private static function writeJob(array $job): void
    {
        $file = self::jobFile($job['id']);
        file_put_contents($file . '.tmp', json_encode($job, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        @rename($file . '.tmp', $file);
    }

    private static function readJob(string $id): ?array
    {
        $file = self::jobFile($id);
        $data = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
        return is_array($data) ? $data : null;
    }

    public static function start(array $body): array
    {
        $spec = [];
        if (!empty($body['link'])) {
            $link = self::parseLink((string) $body['link']);
            if ($link === null) {
                throw new HttpError(400, 'Link do Google Drive inválido');
            }
            $spec = ['source' => 'public'] + $link;
        } elseif (!empty($body['items']) && is_array($body['items'])) {
            Google::token();
            $items = [];
            foreach (array_slice($body['items'], 0, 500) as $item) {
                if (is_array($item) && preg_match('#^[\w-]+$#', (string) ($item['id'] ?? ''))) {
                    $items[] = ['id' => (string) $item['id'], 'name' => (string) ($item['name'] ?? 'arquivo'), 'folder' => !empty($item['folder'])];
                }
            }
            if (!$items) {
                throw new HttpError(400, 'Nada selecionado');
            }
            $spec = ['source' => 'account', 'items' => $items];
        } else {
            throw new HttpError(400, 'Informe um link ou selecione arquivos');
        }
        $job = [
            'id' => 'j' . bin2hex(random_bytes(8)),
            'source' => $spec['source'],
            'spec' => $spec,
            'title' => $spec['source'] === 'account' ? 'Minha conta' : '',
            'status' => 'queued',
            'files' => 0,
            'done' => 0,
            'skipped' => 0,
            'bytes' => 0,
            'already' => 0,
            'analyzed' => false,
            'totalBytes' => 0,
            'estimated' => false,
            'speed' => 0,
            'eta' => null,
            'current' => '',
            'errors' => [],
            'started' => time(),
            'updated' => time(),
        ];
        self::writeJob($job);
        self::spawn($job['id']);
        return self::publicJob($job);
    }

    private static function spawn(string $id): void
    {
        $php = PHP_BINARY !== '' ? PHP_BINARY : 'php';
        $script = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'cli' . DIRECTORY_SEPARATOR . 'drive-job.php';
        $extra = trim((string) getenv('COMICSTREAM_PHP_ARGS'));
        if (PHP_OS_FAMILY === 'Windows') {
            $cmd = 'start "" /B ' . escapeshellarg($php) . ' ' . $extra . ' ' . escapeshellarg($script) . ' ' . $id . ' >> ' . escapeshellarg(self::logFile($id)) . ' 2>&1';
            $handle = @popen($cmd, 'r');
            if ($handle) {
                pclose($handle);
                return;
            }
        } else {
            @exec(escapeshellarg($php) . ' ' . $extra . ' ' . escapeshellarg($script) . ' ' . $id . ' >> ' . escapeshellarg(self::logFile($id)) . ' 2>&1 &');
            return;
        }
        throw new HttpError(500, 'Não consegui iniciar o download em segundo plano');
    }

    private static function publicJob(array $job): array
    {
        unset($job['spec']);
        $job['errors'] = array_slice($job['errors'], 0, 5);
        return $job;
    }

    public static function jobs(): array
    {
        $list = [];
        foreach (glob(self::jobsDir() . DIRECTORY_SEPARATOR . 'j*.json') ?: [] as $file) {
            $job = json_decode((string) file_get_contents($file), true);
            if (!is_array($job)) {
                continue;
            }
            if (in_array($job['status'], ['queued', 'listing', 'analyzing', 'awaiting', 'downloading'], true) && time() - (int) $job['updated'] > 180) {
                $job['status'] = 'error';
                $log = self::logFile($job['id']);
                $last = is_file($log) ? trim((string) @file_get_contents($log, false, null, max(0, (int) filesize($log) - 400))) : '';
                $job['errors'][] = 'O download parou de responder' . ($last !== '' ? ': ' . preg_replace('/\s+/', ' ', substr($last, -300)) : '');
            }
            $list[] = self::publicJob($job);
        }
        usort($list, static fn(array $a, array $b): int => $b['started'] <=> $a['started']);
        foreach (array_slice($list, 15) as $old) {
            @unlink(self::jobFile($old['id']));
            @unlink(self::logFile($old['id']));
        }
        return ['jobs' => array_slice($list, 0, 10)];
    }

    public static function cancel(string $id): array
    {
        self::jobFile($id);
        touch(self::jobsDir() . DIRECTORY_SEPARATOR . $id . '.cancel');
        return ['ok' => true];
    }

    public static function clear(): array
    {
        $removed = 0;
        foreach (glob(self::jobsDir() . DIRECTORY_SEPARATOR . 'j*.json') ?: [] as $file) {
            $job = json_decode((string) file_get_contents($file), true);
            if (!is_array($job) || in_array($job['status'] ?? '', ['queued', 'listing', 'analyzing', 'awaiting', 'downloading'], true)) {
                continue;
            }
            $id = (string) ($job['id'] ?? '');
            if (!preg_match('/^j[a-f0-9]{16}$/', $id)) {
                continue;
            }
            @unlink($file);
            @unlink(self::logFile($id));
            $removed++;
        }
        return ['ok' => true, 'removed' => $removed];
    }

    public static function confirm(string $id): array
    {
        self::jobFile($id);
        touch(self::jobsDir() . DIRECTORY_SEPARATOR . $id . '.go');
        return ['ok' => true];
    }

    public static function crashed(string $id, string $message): void
    {
        $job = self::readJob($id);
        if ($job === null || !in_array($job['status'], ['queued', 'listing', 'analyzing', 'awaiting', 'downloading'], true)) {
            return;
        }
        $job['status'] = 'error';
        $job['errors'][] = $message;
        $job['current'] = '';
        $job['updated'] = time();
        self::writeJob($job);
    }

    public static function logFile(string $id): string
    {
        return self::jobFile($id) . '.log';
    }

    public static function runJob(string $id): void
    {
        $job = self::readJob($id);
        if ($job === null) {
            return;
        }
        $cancelFile = self::jobsDir() . DIRECTORY_SEPARATOR . $id . '.cancel';
        $cancelled = static fn(): bool => is_file($cancelFile);
        $lastWrite = 0.0;
        $touch = static function (bool $force = false) use (&$job, &$lastWrite): void {
            $now = microtime(true);
            if ($force || $now - $lastWrite > 0.5) {
                $job['updated'] = time();
                self::writeJob($job);
                $lastWrite = $now;
            }
        };
        try {
            $job['status'] = 'listing';
            $touch(true);
            $spec = $job['spec'];
            $list = [];
            $tick = static function (string $rel) use (&$job, $touch): void {
                $job['current'] = $rel === '' ? 'Lendo a pasta' : 'Lendo ' . $rel;
                $touch(true);
            };
            $tickPublic = static function (int $folders) use (&$job, $touch): void {
                $job['current'] = 'Lendo ' . $folders . ($folders === 1 ? ' pasta' : ' pastas') . ' · ' . $job['files'] . ' HQs encontradas';
                $touch();
            };
            $base = 'Downloads';
            if ($spec['source'] === 'public') {
                if ($spec['type'] === 'folder') {
                    self::listPublicTree($spec['id'], $list, $job, $tickPublic);
                    $base .= '/' . (Paths::sanitizeUpload($job['title']) ?: 'Google Drive');
                } else {
                    $page = Net::request('GET', 'https://drive.google.com/file/d/' . rawurlencode($spec['id']) . '/view');
                    $name = self::parseFileTitle((string) $page['body']);
                    $job['title'] = $name !== '' ? $name : 'Arquivo do Drive';
                    if ($name !== '' && self::supported($name)) {
                        $list[] = ['id' => $spec['id'], 'name' => $name, 'rel' => '', 'source' => 'public', 'size' => 0];
                    } else {
                        $list[] = ['id' => $spec['id'], 'name' => '', 'rel' => '', 'source' => 'public', 'size' => 0];
                    }
                }
            } else {
                foreach ($spec['items'] as $item) {
                    if ($item['folder']) {
                        self::listAccountTree($item['id'], $item['name'], 0, $list, $tick);
                    } else {
                        $list[] = ['id' => $item['id'], 'name' => $item['name'], 'rel' => '', 'source' => 'account', 'size' => 0];
                    }
                }
            }
            $job['files'] = count($list);
            $root = Config::library();
            $pending = [];
            foreach ($list as $item) {
                if ($item['name'] !== '' && self::existing($root, $base, $item)) {
                    $job['done']++;
                } else {
                    $pending[] = $item;
                }
            }
            $job['already'] = $job['done'];
            $job['status'] = 'analyzing';
            $touch(true);
            if ($pending && !$cancelled()) {
                self::analyze($pending, $job, $touch, $cancelled);
            } else {
                $job['analyzed'] = true;
                $job['eta'] = 0;
            }
            if ($pending && !$cancelled()) {
                $goFile = self::jobsDir() . DIRECTORY_SEPARATOR . $id . '.go';
                $job['status'] = 'awaiting';
                $job['current'] = '';
                $touch(true);
                $deadline = time() + 900;
                while (!is_file($goFile) && !$cancelled() && time() < $deadline) {
                    usleep(500000);
                    $touch(true);
                }
                if (!is_file($goFile) && !$cancelled()) {
                    touch($cancelFile);
                }
                @unlink($goFile);
            }
            $job['status'] = 'downloading';
            $job['current'] = '';
            $touch(true);
            if ($pending && !$cancelled()) {
                self::downloadAll($pending, $root, $base, $job, $touch, $cancelled);
            }
            $job['status'] = $cancelled() ? 'cancelled' : ($job['files'] === 0 ? 'empty' : 'done');
            $job['eta'] = 0;
        } catch (Throwable $e) {
            $job['status'] = 'error';
            $job['errors'][] = $e->getMessage();
        }
        $job['current'] = '';
        $touch(true);
        @unlink($cancelFile);
    }

    private static function existing(string $root, string $base, array $item): bool
    {
        $dir = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, Paths::sanitizeUpload($base . '/' . $item['rel']));
        $target = $dir . DIRECTORY_SEPARATOR . Paths::sanitizeUpload($item['name']);
        return is_file($target) && filesize($target) > 0;
    }

    private static function downloadAll(array $items, string $root, string $base, array &$job, callable $touch, callable $cancelled): void
    {
        $token = null;
        foreach ($items as $item) {
            if ($item['source'] === 'account') {
                $token = Google::token();
                break;
            }
        }
        $queue = [];
        $tmps = [];
        foreach ($items as $i => $item) {
            $dir = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, Paths::sanitizeUpload($base . '/' . $item['rel']));
            if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
                $job['errors'][] = 'Não consegui criar a pasta de downloads';
                continue;
            }
            $tmp = $dir . DIRECTORY_SEPARATOR . '.' . $item['id'] . '.part';
            $tmps[] = $tmp;
            $queue[] = ['key' => $i, 'sink' => $tmp, 'item' => $item, 'dir' => $dir, 'retry' => false] + self::itemRequest($item, $token);
        }
        $pendingCount = count($queue);
        $completedBytes = 0;
        $completedCount = 0;
        $sampleTime = microtime(true);
        $sampleBytes = 0;
        $refresh = static function () use (&$job, &$sampleTime, &$sampleBytes, &$completedBytes, &$completedCount, $pendingCount): void {
            $now = microtime(true);
            if ($now - $sampleTime >= 1.0) {
                $rate = ($job['bytes'] - $sampleBytes) / ($now - $sampleTime);
                $job['speed'] = $job['speed'] > 0 ? 0.6 * $job['speed'] + 0.4 * $rate : $rate;
                $sampleTime = $now;
                $sampleBytes = $job['bytes'];
            }
            if ($job['estimated'] && $completedCount >= 3) {
                $job['totalBytes'] = (int) ($completedBytes + ($pendingCount - $completedCount) * ($completedBytes / $completedCount));
            }
            if ($job['speed'] > 0) {
                $job['eta'] = (int) ceil(max(0, $job['totalBytes'] - $job['bytes']) / $job['speed']);
            }
        };
        $onDone = static function (array $req, array $res) use (&$job, &$completedBytes, &$completedCount, $touch, $cancelled): ?array {
            $item = $req['item'];
            $tmp = $req['sink'];
            $label = $item['name'] !== '' ? $item['name'] . ': ' : '';
            if ($cancelled()) {
                @unlink($tmp);
                return null;
            }
            if ($res['error'] !== '') {
                @unlink($tmp);
                if (($req['tries'] ?? 0) < 3) {
                    return ['tries' => ($req['tries'] ?? 0) + 1] + $req;
                }
                $job['errors'][] = $label . $res['error'];
                return null;
            }
            $html = str_contains($res['headers']['content-type'] ?? '', 'text/html');
            if ($item['source'] === 'public' && $html) {
                $retry = $req['retry'] ? null : self::parseConfirmForm((string) @file_get_contents($tmp, false, null, 0, 400000));
                @unlink($tmp);
                if ($retry === null) {
                    $job['errors'][] = $label . ($req['retry'] ? 'o Drive bloqueou o download' : 'o Drive bloqueou o download (limite de cota ou arquivo privado)');
                    return null;
                }
                return ['url' => $retry, 'retry' => true] + $req;
            }
            if ($res['status'] >= 400) {
                @unlink($tmp);
                $job['errors'][] = $label . 'o Google Drive respondeu ' . $res['status'];
                return null;
            }
            $name = $item['name'];
            if ($name === '') {
                $name = self::filenameFrom($res['headers']['content-disposition'] ?? '') ?: ('drive-' . $item['id']);
                if (!self::supported($name)) {
                    @unlink($tmp);
                    $job['skipped']++;
                    return null;
                }
            }
            $target = $req['dir'] . DIRECTORY_SEPARATOR . Paths::sanitizeUpload($name);
            @unlink($target);
            if (!@rename($tmp, $target)) {
                @unlink($tmp);
                $job['errors'][] = $label . 'não consegui salvar o arquivo';
                return null;
            }
            $completedBytes += (int) @filesize($target);
            $completedCount++;
            $job['done']++;
            $job['current'] = $name;
            $touch(true);
            return null;
        };
        $onTick = static function (array $now) use (&$job, &$completedBytes, $touch, $cancelled, $refresh): bool {
            $job['bytes'] = $completedBytes + array_sum($now);
            if ($now) {
                $job['current'] = $job['current'] !== '' ? $job['current'] : 'baixando';
            }
            $refresh();
            $touch();
            return !$cancelled();
        };
        Net::multi($queue, 3, $onDone, $onTick);
        if ($cancelled()) {
            foreach ($tmps as $tmp) {
                @unlink($tmp);
            }
        }
        $job['bytes'] = $completedBytes;
    }

    private static function filenameFrom(string $header): string
    {
        if (preg_match("#filename\\*=UTF-8''([^;]+)#i", $header, $m)) {
            return rawurldecode(trim($m[1], '"'));
        }
        if (preg_match('#filename="?([^";]+)"?#i', $header, $m)) {
            return trim($m[1]);
        }
        return '';
    }
}
