<?php

declare(strict_types=1);

final class Store
{
    private static function file(string $name): string
    {
        if (!preg_match('/^[a-z]+$/', $name)) {
            throw new HttpError(400, 'Store inválido');
        }
        return Config::storage() . DIRECTORY_SEPARATOR . $name . '.json';
    }

    public static function read(string $name): array
    {
        $file = self::file($name);
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

    public static function update(string $name, callable $change): array
    {
        $handle = fopen(self::file($name), 'c+');
        if ($handle === false) {
            throw new HttpError(500, 'Não foi possível gravar ' . $name);
        }
        flock($handle, LOCK_EX);
        $raw = stream_get_contents($handle);
        $data = json_decode($raw === false || $raw === '' ? '{}' : $raw, true);
        $data = $change(is_array($data) ? $data : []);
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($data ?: new stdClass(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        fflush($handle);
        flock($handle, LOCK_UN);
        fclose($handle);
        return $data;
    }
}
