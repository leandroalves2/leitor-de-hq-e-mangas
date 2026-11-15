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

    private static function listPublicTree(string $id, string $rel, int $depth, array &$out, array &$job): void
    {
        $res = Net::request('GET', 'https://drive.google.com/embeddedfolderview?id=' . rawurlencode($id));
        if ($res['status'] >= 400) {
            throw new RuntimeException('O Google Drive respondeu ' . $res['status'] . '. A pasta está compartilhada como "qualquer pessoa com o link"?');
        }
        $parsed = self::parseFolderHtml((string) $res['body']);
        if ($depth === 0 && $parsed['title'] !== '') {
            $job['title'] = $parsed['title'];
        }
        foreach ($parsed['items'] as $item) {
            if ($item['folder']) {
                if ($depth < 4) {
                    self::listPublicTree($item['id'], $rel === '' ? $item['name'] : $rel . '/' . $item['name'], $depth + 1, $out, $job);
                }
            } elseif (self::supported($item['name'])) {
                $out[] = ['id' => $item['id'], 'name' => $item['name'], 'rel' => $rel, 'source' => 'public'];
            } else {
                $job['skipped']++;
            }
        }
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

    private static function listAccountTree(string $id, string $rel, int $depth, array &$out): void
    {
        foreach (self::listAccount($id)['items'] as $item) {
            if ($item['folder']) {
                if ($depth < 6) {
                    self::listAccountTree($item['id'], $rel === '' ? $item['name'] : $rel . '/' . $item['name'], $depth + 1, $out);
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
            $cmd = 'start "" /B ' . escapeshellarg($php) . ' ' . $extra . ' ' . escapeshellarg($script) . ' ' . $id;
            $handle = @popen($cmd, 'r');
            if ($handle) {
                pclose($handle);
                return;
            }
        } else {
            @exec(escapeshellarg($php) . ' ' . $extra . ' ' . escapeshellarg($script) . ' ' . $id . ' > /dev/null 2>&1 &');
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
            if (in_array($job['status'], ['queued', 'listing', 'downloading'], true) && time() - (int) $job['updated'] > 180) {
                $job['status'] = 'error';
                $job['errors'][] = 'O download parou de responder';
            }
            $list[] = self::publicJob($job);
        }
        usort($list, static fn(array $a, array $b): int => $b['started'] <=> $a['started']);
        foreach (array_slice($list, 15) as $old) {
            @unlink(self::jobFile($old['id']));
        }
        return ['jobs' => array_slice($list, 0, 10)];
    }

    public static function cancel(string $id): array
    {
        self::jobFile($id);
        touch(self::jobsDir() . DIRECTORY_SEPARATOR . $id . '.cancel');
        return ['ok' => true];
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
            $base = 'Downloads';
            if ($spec['source'] === 'public') {
                if ($spec['type'] === 'folder') {
                    self::listPublicTree($spec['id'], '', 0, $list, $job);
                    $base .= '/' . (Paths::sanitizeUpload($job['title']) ?: 'Google Drive');
                } else {
                    $page = Net::request('GET', 'https://drive.google.com/file/d/' . rawurlencode($spec['id']) . '/view');
                    $name = self::parseFileTitle((string) $page['body']);
                    $job['title'] = $name !== '' ? $name : 'Arquivo do Drive';
                    if ($name !== '' && self::supported($name)) {
                        $list[] = ['id' => $spec['id'], 'name' => $name, 'rel' => '', 'source' => 'public'];
                    } else {
                        $list[] = ['id' => $spec['id'], 'name' => '', 'rel' => '', 'source' => 'public'];
                    }
                }
            } else {
                foreach ($spec['items'] as $item) {
                    if ($item['folder']) {
                        self::listAccountTree($item['id'], $item['name'], 0, $list);
                    } else {
                        $list[] = ['id' => $item['id'], 'name' => $item['name'], 'rel' => '', 'source' => 'account'];
                    }
                }
            }
            $job['files'] = count($list);
            $job['status'] = 'downloading';
            $touch(true);
            $root = Config::library();
            foreach ($list as $item) {
                if ($cancelled()) {
                    break;
                }
                try {
                    self::downloadItem($item, $root, $base, $job, $touch, $cancelled);
                } catch (Throwable $e) {
                    $job['errors'][] = ($item['name'] !== '' ? $item['name'] . ': ' : '') . $e->getMessage();
                }
                $touch(true);
            }
            $job['status'] = $cancelled() ? 'cancelled' : ($job['files'] === 0 ? 'empty' : 'done');
        } catch (Throwable $e) {
            $job['status'] = 'error';
            $job['errors'][] = $e->getMessage();
        }
        $job['current'] = '';
        $touch(true);
        @unlink($cancelFile);
    }

    private static function downloadItem(array $item, string $root, string $base, array &$job, callable $touch, callable $cancelled): void
    {
        $dir = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, Paths::sanitizeUpload($base . '/' . $item['rel']));
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException('Não consegui criar a pasta de downloads');
        }
        if ($item['name'] !== '') {
            $target = $dir . DIRECTORY_SEPARATOR . Paths::sanitizeUpload($item['name']);
            if (is_file($target) && filesize($target) > 0) {
                $job['done']++;
                return;
            }
        }
        $tmp = $dir . DIRECTORY_SEPARATOR . '.' . $item['id'] . '.part';
        $startBytes = $job['bytes'];
        $job['current'] = $item['name'] !== '' ? $item['name'] : 'arquivo';
        $progress = static function (int $now) use (&$job, $startBytes, $touch, $cancelled): bool {
            $job['bytes'] = $startBytes + $now;
            $touch();
            return !$cancelled();
        };
        if ($item['source'] === 'account') {
            $url = 'https://www.googleapis.com/drive/v3/files/' . rawurlencode($item['id']) . '?alt=media&supportsAllDrives=true';
            $res = Net::request('GET', $url, ['Authorization: Bearer ' . Google::token()], null, $tmp, $progress);
            if ($res['status'] >= 400) {
                @unlink($tmp);
                throw new RuntimeException('o Google Drive respondeu ' . $res['status']);
            }
        } else {
            $url = 'https://drive.usercontent.google.com/download?id=' . rawurlencode($item['id']) . '&export=download&confirm=t';
            $res = Net::request('GET', $url, [], null, $tmp, $progress);
            if (str_contains($res['headers']['content-type'] ?? '', 'text/html')) {
                $retry = self::parseConfirmForm((string) file_get_contents($tmp));
                @unlink($tmp);
                if ($retry === null) {
                    throw new RuntimeException('o Drive bloqueou o download (limite de cota ou arquivo privado)');
                }
                $res = Net::request('GET', $retry, [], null, $tmp, $progress);
                if (str_contains($res['headers']['content-type'] ?? '', 'text/html')) {
                    @unlink($tmp);
                    throw new RuntimeException('o Drive bloqueou o download');
                }
            }
            if ($res['status'] >= 400) {
                @unlink($tmp);
                throw new RuntimeException('o Google Drive respondeu ' . $res['status']);
            }
            if ($item['name'] === '') {
                $item['name'] = self::filenameFrom($res['headers']['content-disposition'] ?? '') ?: ('drive-' . $item['id']);
                if (!self::supported($item['name'])) {
                    @unlink($tmp);
                    $job['skipped']++;
                    return;
                }
            }
        }
        if ($cancelled()) {
            @unlink($tmp);
            return;
        }
        $target = $dir . DIRECTORY_SEPARATOR . Paths::sanitizeUpload($item['name']);
        @unlink($target);
        if (!@rename($tmp, $target)) {
            @unlink($tmp);
            throw new RuntimeException('não consegui salvar o arquivo');
        }
        $job['done']++;
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
