<?php

declare(strict_types=1);

final class Thumbs
{
    private static function path(string $key): string
    {
        if (!preg_match('/^[a-f0-9]{20}$/', $key)) {
            throw new HttpError(400, 'Chave inválida');
        }
        return Config::storage('thumbs') . DIRECTORY_SEPARATOR . $key . '.jpg';
    }

    public static function send(string $key): void
    {
        $path = self::path($key);
        if (!is_file($path)) {
            throw new HttpError(404, 'Capa ainda não gerada');
        }
        Http::sendFile($path, 'image/jpeg', '"t-' . $key . '"');
    }

    public static function save(string $rel, string $key): void
    {
        $rel = Paths::normalize($rel);
        $full = Paths::resolve($rel, true);
        if (Library::keyFor($rel, $full) !== $key) {
            throw new HttpError(409, 'Arquivo mudou, recarregue a estante');
        }
        $max = (int) Config::get('thumbMaxBytes', 600000);
        $data = file_get_contents('php://input', false, null, 0, $max + 1);
        if ($data === false || strlen($data) < 64 || strlen($data) > $max) {
            throw new HttpError(413, 'Capa inválida');
        }
        if (!str_starts_with($data, "\xFF\xD8\xFF")) {
            throw new HttpError(415, 'A capa precisa ser JPEG');
        }
        $path = self::path($key);
        $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
        file_put_contents($tmp, $data);
        @rename($tmp, $path) || @unlink($tmp);
    }
}
