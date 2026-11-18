<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli' || !isset($argv[1]) || !preg_match('/^j[a-f0-9]{16}$/', (string) $argv[1])) {
    exit(1);
}

require __DIR__ . '/../bootstrap.php';

$id = (string) $argv[1];
set_time_limit(0);
ignore_user_abort(true);
ini_set('log_errors', '1');
ini_set('display_errors', '0');
ini_set('error_log', Drive::logFile($id));

register_shutdown_function(static function () use ($id): void {
    $error = error_get_last();
    if ($error !== null && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        Drive::crashed($id, 'Erro interno: ' . $error['message']);
    }
});

if (!function_exists('curl_init') && !extension_loaded('openssl')) {
    Drive::crashed($id, 'O PHP do download está sem as extensões curl e openssl');
    exit(1);
}

try {
    Drive::runJob($id);
} catch (Throwable $e) {
    error_log((string) $e);
    Drive::crashed($id, $e->getMessage());
}
