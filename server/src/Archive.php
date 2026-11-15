<?php

declare(strict_types=1);

final class Archive
{
    public static function detect(string $file): string
    {
        $handle = @fopen($file, 'rb');
        $sig = $handle ? (string) fread($handle, 8) : '';
        if ($handle) {
            fclose($handle);
        }
        if (str_starts_with($sig, "PK\x03\x04") || str_starts_with($sig, "PK\x05\x06")) {
            return 'zip';
        }
        if (str_starts_with($sig, 'Rar!')) {
            return 'rar';
        }
        if (str_starts_with($sig, "7z\xBC\xAF\x27\x1C")) {
            return '7z';
        }
        return match (strtolower(pathinfo($file, PATHINFO_EXTENSION))) {
            'cbr', 'rar' => 'rar',
            'cb7', '7z' => '7z',
            default => 'zip',
        };
    }

    public static function pages(string $file, string $key): array
    {
        $cache = Config::storage('cache/lists') . DIRECTORY_SEPARATOR . $key . '.json';
        if (is_file($cache)) {
            $data = json_decode((string) file_get_contents($cache), true);
            if (is_array($data) && isset($data['driver'], $data['pages'])) {
                return $data;
            }
        }

        $type = self::detect($file);
        if ($type === 'zip' && class_exists('ZipArchive')) {
            $data = ['driver' => 'zip', 'pages' => self::zipPages($file)];
        } elseif ($type === 'rar' && class_exists('RarArchive')) {
            $data = ['driver' => 'rar', 'pages' => self::rarPages($file)];
        } else {
            $data = ['driver' => 'dir', 'pages' => self::dirPages(self::extract($file, $key))];
        }

        if (count($data['pages']) === 0) {
            throw new HttpError(422, 'Nenhuma imagem encontrada dentro deste arquivo');
        }
        file_put_contents($cache, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
        return $data;
    }

    public static function sendPage(string $file, string $key, int $index): void
    {
        $data = self::pages($file, $key);
        $page = $data['pages'][$index] ?? null;
        if ($page === null) {
            throw new HttpError(404, 'Página não encontrada');
        }
        $etag = '"' . $key . '-' . $index . '"';
        if (self::etagHit($etag)) {
            return;
        }
        $mime = Http::mime('x.' . $page['e']);

        if ($data['driver'] === 'zip') {
            $zip = new ZipArchive();
            if ($zip->open($file, ZipArchive::RDONLY) !== true) {
                throw new HttpError(500, 'Não foi possível abrir o arquivo');
            }
            $bytes = $zip->getFromIndex((int) $page['n']);
            $zip->close();
            if ($bytes === false) {
                throw new HttpError(500, 'Página corrompida');
            }
            Http::sendBytes($bytes, $mime, $etag);
            return;
        }

        if ($data['driver'] === 'rar') {
            $rar = RarArchive::open($file);
            $entry = $rar ? $rar->getEntry((string) $page['n']) : false;
            $stream = $entry ? $entry->getStream() : false;
            if (!$stream) {
                throw new HttpError(500, 'Página corrompida');
            }
            Http::sendStream($stream, $mime, (int) $entry->getUnpackedSize(), $etag);
            fclose($stream);
            $rar->close();
            return;
        }

        $dir = self::extract($file, $key);
        $path = $dir . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, (string) $page['n']);
        $real = realpath($path);
        if ($real === false || !Paths::inside($real, $dir)) {
            throw new HttpError(404, 'Página não encontrada');
        }
        Http::sendFile($real, $mime, $etag);
    }

    private static function etagHit(string $etag): bool
    {
        if (Http::etagMatches($etag)) {
            header('ETag: ' . $etag);
            http_response_code(304);
            return true;
        }
        return false;
    }

    private static function isPage(string $name): bool
    {
        $name = str_replace('\\', '/', $name);
        if (str_contains($name, '__MACOSX/')) {
            return false;
        }
        $base = basename($name);
        if ($base === '' || $base[0] === '.') {
            return false;
        }
        return in_array(strtolower(pathinfo($base, PATHINFO_EXTENSION)), Library::IMAGES, true);
    }

    private static function sortPages(array $list): array
    {
        usort($list, static fn(array $a, array $b): int => strnatcasecmp($a['s'], $b['s']));
        return array_map(static fn(array $x): array => ['n' => $x['n'], 'e' => $x['e']], $list);
    }

    private static function zipPages(string $file): array
    {
        $zip = new ZipArchive();
        if ($zip->open($file, ZipArchive::RDONLY) !== true) {
            throw new HttpError(422, 'Arquivo CBZ/ZIP corrompido');
        }
        $list = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            if (!$stat || str_ends_with($stat['name'], '/') || !self::isPage($stat['name'])) {
                continue;
            }
            $list[] = ['n' => $i, 'e' => strtolower(pathinfo($stat['name'], PATHINFO_EXTENSION)), 's' => $stat['name']];
        }
        $zip->close();
        return self::sortPages($list);
    }

    private static function rarPages(string $file): array
    {
        $rar = RarArchive::open($file);
        if (!$rar) {
            throw new HttpError(422, 'Arquivo CBR/RAR corrompido');
        }
        $list = [];
        foreach ($rar->getEntries() ?: [] as $entry) {
            $name = $entry->getName();
            if ($entry->isDirectory() || !self::isPage($name)) {
                continue;
            }
            $list[] = ['n' => $name, 'e' => strtolower(pathinfo($name, PATHINFO_EXTENSION)), 's' => $name];
        }
        $rar->close();
        return self::sortPages($list);
    }

    private static function dirPages(string $dir): array
    {
        $list = [];
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
        $prefix = strlen($dir) + 1;
        foreach ($iterator as $item) {
            if (!$item->isFile()) {
                continue;
            }
            $rel = str_replace('\\', '/', substr($item->getPathname(), $prefix));
            if (!self::isPage($rel)) {
                continue;
            }
            $list[] = ['n' => $rel, 'e' => strtolower($item->getExtension()), 's' => $rel];
        }
        return self::sortPages($list);
    }

    private static function extract(string $file, string $key): string
    {
        $base = Config::storage('cache/extract');
        $dir = $base . DIRECTORY_SEPARATOR . $key;
        $done = $dir . DIRECTORY_SEPARATOR . '.done';
        if (is_file($done)) {
            @touch($dir);
            return realpath($dir) ?: $dir;
        }

        $lockPath = $base . DIRECTORY_SEPARATOR . $key . '.lock';
        $lock = fopen($lockPath, 'c');
        if ($lock === false) {
            throw new HttpError(500, 'Não foi possível preparar o cache');
        }
        flock($lock, LOCK_EX);
        try {
            if (!is_file($done)) {
                self::removeDir($dir);
                mkdir($dir, 0775, true);
                $null = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
                $proc = proc_open(self::extractCommand($file, $dir), [0 => ['file', $null, 'r'], 1 => ['file', $null, 'w'], 2 => ['file', $null, 'w']], $pipes);
                $code = is_resource($proc) ? proc_close($proc) : -1;
                if ($code !== 0 && count(self::dirPages($dir)) === 0) {
                    self::removeDir($dir);
                    throw new HttpError(422, 'Não foi possível extrair este arquivo');
                }
                file_put_contents($done, '1');
                self::prune($base, $key);
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
            @unlink($lockPath);
        }
        return realpath($dir) ?: $dir;
    }

    private static function extractCommand(string $file, string $dir): array
    {
        $seven = self::tool('sevenZip', [
            (getenv('ProgramFiles') ?: 'C:\\Program Files') . '\\7-Zip\\7z.exe',
            (getenv('ProgramFiles(x86)') ?: 'C:\\Program Files (x86)') . '\\7-Zip\\7z.exe',
            '/usr/bin/7z', '/usr/bin/7zz', '/usr/bin/7za', '/usr/local/bin/7z', '/opt/homebrew/bin/7z', '/opt/homebrew/bin/7zz',
        ], ['7z', '7zz', '7za']);
        if ($seven !== null) {
            return [$seven, 'x', '-y', '-bso0', '-bsp0', '-o' . $dir, $file];
        }
        $unrar = self::tool('unrar', [
            (getenv('ProgramFiles') ?: 'C:\\Program Files') . '\\WinRAR\\UnRAR.exe',
            '/usr/bin/unrar', '/usr/local/bin/unrar', '/opt/homebrew/bin/unrar',
        ], ['unrar']);
        if ($unrar !== null && self::detect($file) === 'rar') {
            return [$unrar, 'x', '-y', '-inul', $file, $dir . DIRECTORY_SEPARATOR];
        }
        throw new HttpError(501, 'Para abrir CBR/CB7 instale o 7-Zip (7-zip.org) ou ative a extensão zip/rar do PHP.');
    }

    private static function tool(string $configKey, array $paths, array $names): ?string
    {
        $configured = Config::get($configKey);
        if (is_string($configured) && $configured !== '' && is_file($configured)) {
            return $configured;
        }
        foreach ($paths as $path) {
            if (@is_file($path)) {
                return $path;
            }
        }
        if (!function_exists('shell_exec')) {
            return null;
        }
        foreach ($names as $name) {
            $cmd = PHP_OS_FAMILY === 'Windows' ? 'where ' . $name . ' 2>NUL' : 'command -v ' . escapeshellarg($name) . ' 2>/dev/null';
            $out = trim((string) @shell_exec($cmd));
            $first = trim(strtok($out, "\r\n") ?: '');
            if ($first !== '' && @is_file($first)) {
                return $first;
            }
        }
        return null;
    }

    private static function prune(string $base, string $keep): void
    {
        $limit = (int) Config::get('extractCacheLimit', 8);
        $dirs = [];
        foreach (scandir($base) ?: [] as $name) {
            $path = $base . DIRECTORY_SEPARATOR . $name;
            if ($name !== '.' && $name !== '..' && $name !== $keep && is_dir($path)) {
                $dirs[$path] = (int) filemtime($path);
            }
        }
        arsort($dirs);
        foreach (array_slice(array_keys($dirs), max(0, $limit - 1)) as $old) {
            self::removeDir($old);
        }
    }

    private static function removeDir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $item) {
            $item->isDir() && !$item->isLink() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
        }
        @rmdir($dir);
    }
}
