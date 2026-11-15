<?php

$env = static fn(string $name): ?string => ($v = getenv($name)) !== false && $v !== '' ? $v : null;

return [
    'library' => $env('COMICSTREAM_LIBRARY') ?? dirname(__DIR__) . '/uploads',
    'storage' => $env('COMICSTREAM_STORAGE') ?? dirname(__DIR__) . '/storage',
    'sevenZip' => $env('COMICSTREAM_7Z'),
    'unrar' => null,
    'extractCacheLimit' => 8,
    'thumbMaxBytes' => 600000,
];
