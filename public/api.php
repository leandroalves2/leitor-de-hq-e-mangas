<?php

declare(strict_types=1);

require __DIR__ . '/../server/bootstrap.php';

Api::handle((string) ($_GET['r'] ?? ''));
