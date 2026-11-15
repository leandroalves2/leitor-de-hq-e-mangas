<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli' || !isset($argv[1])) {
    exit(1);
}

require __DIR__ . '/../bootstrap.php';

set_time_limit(0);
ignore_user_abort(true);

try {
    Drive::runJob((string) $argv[1]);
} catch (Throwable $e) {
    error_log((string) $e);
}
