<?php

declare(strict_types=1);

final class Extras
{
    private static function text(mixed $value, int $max): string
    {
        $value = is_string($value) ? trim($value) : '';
        $value = preg_replace('/[\x00-\x1F]/u', '', $value) ?? '';
        return preg_replace('/^(.{0,' . $max . '}).*$/us', '$1', $value) ?? '';
    }

    private static function paths(mixed $list, int $max): array
    {
        $out = [];
        if (!is_array($list)) {
            return $out;
        }
        foreach ($list as $item) {
            if (!is_string($item) || $item === '' || strlen($item) > 1024 || str_contains($item, '..')) {
                continue;
            }
            $out[$item] = true;
            if (count($out) >= $max) {
                break;
            }
        }
        return array_keys($out);
    }

    public static function collections(): array
    {
        $data = Store::read('collections');
        return [
            'favorites' => $data['favorites'] ?? [],
            'collections' => ($data['collections'] ?? []) ?: new stdClass(),
        ];
    }

    public static function saveCollections(array $input): array
    {
        $favorites = self::paths($input['favorites'] ?? [], 5000);
        $collections = [];
        if (is_array($input['collections'] ?? null)) {
            foreach ($input['collections'] as $name => $items) {
                $name = self::text((string) $name, 60);
                if ($name === '' || count($collections) >= 200) {
                    continue;
                }
                $collections[$name] = self::paths($items, 2000);
            }
        }
        Store::update('collections', static fn(): array => ['favorites' => $favorites, 'collections' => $collections]);
        return self::collections();
    }

    public static function meta(): array
    {
        return Store::read('meta');
    }

    public static function saveMeta(array $input): void
    {
        $rel = Paths::normalize((string) ($input['path'] ?? ''));
        $full = Paths::resolve($rel, true);
        $key = Library::keyFor($rel, $full);
        if (($input['key'] ?? '') !== $key) {
            throw new HttpError(409, 'Arquivo mudou');
        }
        $entry = [];
        $title = self::text($input['title'] ?? '', 200);
        if ($title !== '') {
            $entry['title'] = $title;
        }
        $pages = (int) ($input['pages'] ?? 0);
        if ($pages > 0 && $pages < 100000) {
            $entry['pages'] = $pages;
        }
        if (!$entry) {
            return;
        }
        Store::update('meta', static function (array $data) use ($key, $entry): array {
            $data[$key] = array_merge($data[$key] ?? [], $entry);
            return $data;
        });
    }

    public static function trash(string $rel): array
    {
        $rel = Paths::normalize($rel);
        if ($rel === '') {
            throw new HttpError(400, 'Não dá para apagar a estante inteira');
        }
        $full = Paths::resolve($rel);
        $base = Config::storage('lixeira' . DIRECTORY_SEPARATOR . date('Y-m-d_His'));
        $dest = $base . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel);
        $parent = dirname($dest);
        if (!is_dir($parent) && !@mkdir($parent, 0775, true) && !is_dir($parent)) {
            throw new HttpError(500, 'Não consegui criar a lixeira');
        }
        if (file_exists($dest)) {
            $dest .= '-' . bin2hex(random_bytes(3));
        }
        if (!@rename($full, $dest)) {
            throw new HttpError(500, 'Não consegui mover para a lixeira. O arquivo está aberto em outro programa?');
        }
        return ['ok' => true, 'trash' => 'storage/lixeira/' . basename($base) . '/' . $rel];
    }

    public static function stats(): array
    {
        $data = Store::read('stats');
        return [
            'days' => ($data['days'] ?? []) ?: new stdClass(),
            'finished' => ($data['finished'] ?? []) ?: new stdClass(),
        ];
    }

    public static function saveStats(array $input): array
    {
        $day = (string) ($input['day'] ?? '');
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $day)) {
            throw new HttpError(400, 'Dia inválido');
        }
        $pages = max(0, min(5000, (int) ($input['pages'] ?? 0)));
        $seconds = max(0, min(86400, (int) ($input['seconds'] ?? 0)));
        $night = max(0, min(5000, (int) ($input['night'] ?? 0)));
        $finished = self::paths($input['finished'] ?? [], 200);

        Store::update('stats', static function (array $data) use ($day, $pages, $seconds, $night, $finished): array {
            $data['days'] ??= [];
            $data['finished'] ??= [];
            $entry = $data['days'][$day] ?? ['pages' => 0, 'seconds' => 0, 'chapters' => 0, 'night' => 0];
            $entry['pages'] += $pages;
            $entry['seconds'] += $seconds;
            $entry['night'] = ($entry['night'] ?? 0) + $night;
            foreach ($finished as $path) {
                if (!isset($data['finished'][$path])) {
                    $data['finished'][$path] = time();
                    $entry['chapters']++;
                }
            }
            $data['days'][$day] = $entry;
            return $data;
        });
        return ['ok' => true];
    }
}
