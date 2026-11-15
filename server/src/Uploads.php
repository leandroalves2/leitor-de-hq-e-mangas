<?php

declare(strict_types=1);

final class Uploads
{
    public static function handle(): array
    {
        $file = $_FILES['file'] ?? null;
        if (!is_array($file) || is_array($file['name'] ?? null)) {
            throw new HttpError(400, 'Nenhum arquivo recebido (verifique post_max_size do PHP)');
        }
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            throw new HttpError(413, self::message((int) $file['error']));
        }

        $rel = Paths::sanitizeUpload((string) ($_POST['path'] ?? $file['name']));
        if ($rel === '' || Library::kind($rel) === null) {
            throw new HttpError(415, 'Formato não suportado: ' . basename($rel));
        }

        $root = Config::library();
        $dest = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel);
        $dir = dirname($dest);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new HttpError(500, 'Não foi possível criar a pasta');
        }
        $realDir = realpath($dir);
        if ($realDir === false || !Paths::inside($realDir, $root)) {
            throw new HttpError(403, 'Destino inválido');
        }
        if (!move_uploaded_file((string) $file['tmp_name'], $realDir . DIRECTORY_SEPARATOR . basename($dest))) {
            throw new HttpError(500, 'Falha ao salvar o arquivo');
        }
        return ['path' => $rel];
    }

    private static function message(int $code): string
    {
        return match ($code) {
            UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'Arquivo maior que o limite do PHP (upload_max_filesize)',
            UPLOAD_ERR_PARTIAL => 'Envio interrompido',
            UPLOAD_ERR_NO_FILE => 'Nenhum arquivo enviado',
            UPLOAD_ERR_NO_TMP_DIR, UPLOAD_ERR_CANT_WRITE => 'O servidor não conseguiu gravar o arquivo',
            default => 'Erro no envio (' . $code . ')',
        };
    }
}
