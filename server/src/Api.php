<?php

declare(strict_types=1);

final class Api
{
    public static function handle(string $route): void
    {
        try {
            $method = Http::method();
            $get = $method === 'GET' || $method === 'HEAD';
            match (true) {
                $route === 'tree' && $get => self::tree(),
                $route === 'file' && $get => self::file(),
                $route === 'pages' && $get => self::pages(),
                $route === 'page' && $get => self::page(),
                $route === 'thumb' && $get => Thumbs::send((string) ($_GET['k'] ?? '')),
                $route === 'thumb' && $method === 'POST' => self::saveThumb(),
                $route === 'progress' && $get => Http::json(Progress::all() ?: new stdClass()),
                $route === 'progress' && $method === 'POST' => self::saveProgress(),
                $route === 'upload' && $method === 'POST' => Http::json(Uploads::handle()),
                $route === 'collections' && $get => Http::json(Extras::collections()),
                $route === 'collections' && $method === 'POST' => Http::json(Extras::saveCollections(Http::readJson())),
                $route === 'meta' && $method === 'POST' => self::saveMeta(),
                $route === 'stats' && $get => Http::json(Extras::stats()),
                $route === 'google' && $get => Http::json(Google::status()),
                $route === 'google-config' && $method === 'POST' => Http::json(Google::configure(Http::readJson())),
                $route === 'google-login' && $get => Http::json(Google::loginUrl()),
                $route === 'google-logout' && $method === 'POST' => Http::json(Google::logout()),
                $route === 'drive-list' && $get => Http::json(Drive::listAccount((string) ($_GET['folder'] ?? 'root'))),
                $route === 'drive-download' && $method === 'POST' => Http::json(Drive::start(Http::readJson())),
                $route === 'drive-jobs' && $get => Http::json(Drive::jobs()),
                $route === 'drive-cancel' && $method === 'POST' => Http::json(Drive::cancel((string) (Http::readJson()['id'] ?? ''))),
                $route === 'delete' && $method === 'POST' => Http::json(Extras::trash((string) (Http::readJson()['path'] ?? ''))),
                $route === 'stats' && $method === 'POST' => Http::json(Extras::saveStats(Http::readJson())),
                default => throw new HttpError(404, 'Rota inexistente'),
            };
        } catch (HttpError $e) {
            Http::json(['error' => $e->getMessage()], $e->status);
        } catch (Throwable $e) {
            error_log((string) $e);
            Http::json(['error' => 'Erro interno: ' . $e->getMessage()], 500);
        }
    }

    private static function target(?string $kind = null): array
    {
        $rel = Paths::normalize((string) ($_GET['p'] ?? ''));
        $full = Paths::resolve($rel, true);
        $actual = Library::kind($full);
        if ($actual === null || ($kind !== null && $actual !== $kind)) {
            throw new HttpError(415, 'Formato não suportado');
        }
        return [$rel, $full, Library::keyFor($rel, $full)];
    }

    private static function tree(): void
    {
        Http::json([
            'root' => Library::tree(),
            'progress' => Progress::all() ?: new stdClass(),
            'collections' => Extras::collections(),
            'meta' => Extras::meta() ?: new stdClass(),
            'features' => [
                'zip' => class_exists('ZipArchive'),
                'rar' => class_exists('RarArchive'),
            ],
        ]);
    }

    private static function file(): void
    {
        [, $full, $key] = self::target();
        Http::sendFile($full, Http::mime($full), '"' . $key . '"', 'private, max-age=86400');
    }

    private static function pages(): void
    {
        [, $full, $key] = self::target('archive');
        $data = Archive::pages($full, $key);
        Http::json(['count' => count($data['pages']), 'key' => $key]);
    }

    private static function page(): void
    {
        [, $full, $key] = self::target('archive');
        Archive::sendPage($full, $key, (int) ($_GET['i'] ?? 0));
    }

    private static function saveThumb(): void
    {
        Thumbs::save((string) ($_GET['p'] ?? ''), (string) ($_GET['k'] ?? ''));
        Http::json(['ok' => true]);
    }

    private static function saveMeta(): void
    {
        Extras::saveMeta(Http::readJson());
        Http::json(['ok' => true]);
    }

    private static function saveProgress(): void
    {
        $data = Http::readJson();
        $entry = Progress::save((string) ($data['path'] ?? ''), (int) ($data['page'] ?? 0), (int) ($data['total'] ?? 0));
        Http::json(['ok' => true, 'entry' => $entry]);
    }
}
