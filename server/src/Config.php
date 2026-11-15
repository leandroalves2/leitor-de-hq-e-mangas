<?php

declare(strict_types=1);

final class Config
{
    private static array $values = [];

    public static function load(array $values): void
    {
        self::$values = $values;
        foreach (['library', 'storage'] as $key) {
            if (!is_dir($values[$key])) {
                @mkdir($values[$key], 0775, true);
            }
        }
    }

    public static function get(string $key, mixed $default = null): mixed
    {
        return self::$values[$key] ?? $default;
    }

    public static function library(): string
    {
        $path = realpath((string) self::$values['library']);
        if ($path === false) {
            throw new HttpError(500, 'Pasta da biblioteca não encontrada');
        }
        return $path;
    }

    public static function storage(string $sub = ''): string
    {
        $dir = rtrim((string) self::$values['storage'], '/\\');
        if ($sub !== '') {
            $dir .= DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $sub);
        }
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        return $dir;
    }
}
