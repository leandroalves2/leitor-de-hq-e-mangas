<?php

declare(strict_types=1);

final class Http
{
    private const MIME = [
        'pdf' => 'application/pdf',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png' => 'image/png',
        'webp' => 'image/webp',
        'gif' => 'image/gif',
        'avif' => 'image/avif',
        'bmp' => 'image/bmp',
        'cbz' => 'application/vnd.comicbook+zip',
        'zip' => 'application/zip',
        'cbr' => 'application/vnd.comicbook-rar',
        'rar' => 'application/vnd.rar',
        'cb7' => 'application/x-cb7',
        '7z' => 'application/x-7z-compressed',
    ];

    public static function mime(string $name): string
    {
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        return self::MIME[$ext] ?? 'application/octet-stream';
    }

    public static function method(): string
    {
        return strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    }

    public static function json(mixed $data, int $status = 200): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
            header('X-Content-Type-Options: nosniff');
        }
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    public static function readJson(): array
    {
        $raw = file_get_contents('php://input', false, null, 0, 65536);
        $data = json_decode($raw === false ? '' : $raw, true);
        if (!is_array($data)) {
            throw new HttpError(400, 'JSON inválido');
        }
        return $data;
    }

    public static function etagMatches(string $etag): bool
    {
        $header = (string) ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
        if ($header === '') {
            return false;
        }
        foreach (explode(',', $header) as $candidate) {
            if (trim($candidate) === $etag || trim($candidate) === 'W/' . $etag) {
                return true;
            }
        }
        return false;
    }

    private static function common(string $mime, string $etag, string $cache): void
    {
        header('Content-Type: ' . $mime);
        header('ETag: ' . $etag);
        header('Cache-Control: ' . $cache);
        header('X-Content-Type-Options: nosniff');
    }

    public static function sendFile(string $path, string $mime, string $etag, string $cache = 'private, max-age=31536000, immutable'): void
    {
        $size = (int) filesize($path);
        self::common($mime, $etag, $cache);
        header('Accept-Ranges: bytes');
        $range = trim((string) ($_SERVER['HTTP_RANGE'] ?? ''));

        if ($range === '' && self::etagMatches($etag)) {
            http_response_code(304);
            return;
        }

        $start = 0;
        $end = $size - 1;
        if ($range !== '') {
            if (!preg_match('/^bytes=(\d*)-(\d*)$/', $range, $m) || ($m[1] === '' && $m[2] === '')) {
                http_response_code(416);
                header('Content-Range: bytes */' . $size);
                return;
            }
            if ($m[1] === '') {
                $start = max(0, $size - (int) $m[2]);
            } else {
                $start = (int) $m[1];
                if ($m[2] !== '') {
                    $end = min((int) $m[2], $size - 1);
                }
            }
            if ($start > $end || $start >= $size) {
                http_response_code(416);
                header('Content-Range: bytes */' . $size);
                return;
            }
            http_response_code(206);
            header("Content-Range: bytes {$start}-{$end}/{$size}");
        }

        $length = $end - $start + 1;
        header('Content-Length: ' . $length);
        if (self::method() === 'HEAD') {
            return;
        }

        @set_time_limit(0);
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        $fp = fopen($path, 'rb');
        if ($fp === false) {
            return;
        }
        fseek($fp, $start);
        $remaining = $length;
        while ($remaining > 0 && !feof($fp)) {
            $chunk = fread($fp, (int) min(262144, $remaining));
            if ($chunk === false || $chunk === '') {
                break;
            }
            echo $chunk;
            flush();
            $remaining -= strlen($chunk);
            if (connection_aborted()) {
                break;
            }
        }
        fclose($fp);
    }

    public static function sendStream($stream, string $mime, ?int $length, string $etag): void
    {
        self::common($mime, $etag, 'private, max-age=31536000, immutable');
        if ($length !== null && $length > 0) {
            header('Content-Length: ' . $length);
        }
        if (self::method() === 'HEAD') {
            return;
        }
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        fpassthru($stream);
    }

    public static function sendBytes(string $bytes, string $mime, string $etag): void
    {
        self::common($mime, $etag, 'private, max-age=31536000, immutable');
        header('Content-Length: ' . strlen($bytes));
        if (self::method() !== 'HEAD') {
            echo $bytes;
        }
    }
}
