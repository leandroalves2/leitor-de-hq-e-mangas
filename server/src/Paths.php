<?php

declare(strict_types=1);

final class Paths
{
    public static function normalize(string $rel): string
    {
        if (str_contains($rel, "\0")) {
            throw new HttpError(400, 'Caminho inválido');
        }
        $parts = [];
        foreach (explode('/', str_replace('\\', '/', $rel)) as $part) {
            if ($part === '' || $part === '.') {
                continue;
            }
            if ($part === '..') {
                throw new HttpError(400, 'Caminho inválido');
            }
            $parts[] = $part;
        }
        return implode('/', $parts);
    }

    public static function resolve(string $rel, bool $mustBeFile = false): string
    {
        $rel = self::normalize($rel);
        $root = Config::library();
        $target = $rel === '' ? $root : $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel);
        $full = realpath($target);
        if ($full === false) {
            throw new HttpError(404, 'Arquivo não encontrado');
        }
        if (!self::inside($full, $root)) {
            throw new HttpError(403, 'Acesso negado');
        }
        if ($mustBeFile && !is_file($full)) {
            throw new HttpError(404, 'Arquivo não encontrado');
        }
        return $full;
    }

    public static function inside(string $path, string $root): bool
    {
        if (PHP_OS_FAMILY === 'Windows') {
            $path = strtolower($path);
            $root = strtolower($root);
        }
        return $path === $root || str_starts_with($path, rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR);
    }

    public static function sanitizeUpload(string $rel): string
    {
        $parts = [];
        foreach (preg_split('#[\\\\/]+#', $rel) ?: [] as $part) {
            $part = preg_replace('/[\x00-\x1F<>:"|?*]/u', '', $part) ?? '';
            $part = rtrim(trim($part), '. ');
            if ($part === '' || $part === '.' || $part === '..') {
                continue;
            }
            $parts[] = $part;
        }
        return implode('/', $parts);
    }
}
