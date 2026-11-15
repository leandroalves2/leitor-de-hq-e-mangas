<?php

declare(strict_types=1);

final class Library
{
    public const ARCHIVES = ['cbz', 'zip', 'cbr', 'rar', 'cb7', '7z'];
    public const IMAGES = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'];

    public static function kind(string $name): ?string
    {
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if ($ext === 'pdf') {
            return 'pdf';
        }
        if (in_array($ext, self::ARCHIVES, true)) {
            return 'archive';
        }
        if (in_array($ext, self::IMAGES, true)) {
            return 'image';
        }
        return null;
    }

    public static function key(string $rel, int $size, int $mtime): string
    {
        return substr(sha1($rel . '|' . $size . '|' . $mtime), 0, 20);
    }

    public static function keyFor(string $rel, string $full): string
    {
        return self::key($rel, (int) filesize($full), (int) filemtime($full));
    }

    public static function tree(): array
    {
        $thumbs = [];
        foreach (scandir(Config::storage('thumbs')) ?: [] as $name) {
            if (str_ends_with($name, '.jpg')) {
                $thumbs[substr($name, 0, -4)] = true;
            }
        }
        $node = self::scan(Config::library(), '', 'Estante', $thumbs);
        return $node;
    }

    private static function scan(string $dir, string $rel, string $name, array $thumbs): array
    {
        $folders = [];
        $files = [];
        foreach (@scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..' || $entry[0] === '.') {
                continue;
            }
            $full = $dir . DIRECTORY_SEPARATOR . $entry;
            $childRel = $rel === '' ? $entry : $rel . '/' . $entry;
            if (is_dir($full)) {
                $child = self::scan($full, $childRel, $entry, $thumbs);
                if ($child['count'] > 0) {
                    $folders[] = $child;
                }
                continue;
            }
            $kind = self::kind($entry);
            if ($kind === null) {
                continue;
            }
            $size = (int) @filesize($full);
            $mtime = (int) @filemtime($full);
            $key = self::key($childRel, $size, $mtime);
            $files[] = [
                'name' => $entry,
                'path' => $childRel,
                'ext' => strtolower(pathinfo($entry, PATHINFO_EXTENSION)),
                'kind' => $kind,
                'size' => $size,
                'mtime' => $mtime,
                'key' => $key,
                'thumb' => isset($thumbs[$key]),
            ];
        }

        usort($folders, static fn(array $a, array $b): int => strnatcasecmp($a['name'], $b['name']));
        usort($files, static fn(array $a, array $b): int => strnatcasecmp($a['name'], $b['name']));

        $count = count($files);
        $size = 0;
        $mtime = 0;
        foreach ($files as $file) {
            $size += $file['size'];
            $mtime = max($mtime, $file['mtime']);
        }
        foreach ($folders as $folder) {
            $count += $folder['count'];
            $size += $folder['size'];
            $mtime = max($mtime, $folder['mtime']);
        }

        $cover = null;
        foreach ($files as $file) {
            if ($file['kind'] !== 'image') {
                $cover = $file['path'];
                break;
            }
        }
        $cover ??= $files[0]['path'] ?? ($folders[0]['cover'] ?? null);

        return [
            'name' => $name,
            'path' => $rel,
            'folders' => $folders,
            'files' => $files,
            'count' => $count,
            'size' => $size,
            'mtime' => $mtime,
            'cover' => $cover,
        ];
    }
}
