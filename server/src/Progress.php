<?php

declare(strict_types=1);

final class Progress
{
    private static function file(): string
    {
        return Config::storage() . DIRECTORY_SEPARATOR . 'progress.json';
    }

    public static function all(): array
    {
        $file = self::file();
        if (!is_file($file)) {
            return [];
        }
        $handle = fopen($file, 'rb');
        if ($handle === false) {
            return [];
        }
        flock($handle, LOCK_SH);
        $raw = stream_get_contents($handle);
        flock($handle, LOCK_UN);
        fclose($handle);
        $data = json_decode($raw === false ? '' : $raw, true);
        return is_array($data) ? $data : [];
    }

    public static function save(string $rel, int $page, int $total): ?array
    {
        $rel = Paths::normalize($rel);
        Paths::resolve($rel, true);
        $handle = fopen(self::file(), 'c+');
        if ($handle === false) {
            throw new HttpError(500, 'Não foi possível salvar o progresso');
        }
        flock($handle, LOCK_EX);
        $raw = stream_get_contents($handle);
        $data = json_decode($raw === false || $raw === '' ? '{}' : $raw, true);
        $data = is_array($data) ? $data : [];

        if ($page <= 0) {
            unset($data[$rel]);
        } else {
            $total = max(1, $total);
            $data[$rel] = ['page' => min($page, $total), 'total' => $total, 'updated' => time()];
        }

        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($data ?: new stdClass(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        fflush($handle);
        flock($handle, LOCK_UN);
        fclose($handle);
        return $data[$rel] ?? null;
    }
}
