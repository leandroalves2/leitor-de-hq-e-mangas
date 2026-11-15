<?php

declare(strict_types=1);

require __DIR__ . '/../server/bootstrap.php';

$ok = true;
$message = '';
try {
    $email = Google::callback($_GET);
    $message = $email !== '' ? 'Conectado como ' . $email : 'Conta Google conectada';
} catch (Throwable $e) {
    $ok = false;
    $message = $e->getMessage();
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
$title = $ok ? 'Pronto!' : 'Ops!';
$color = $ok ? '#ffd60a' : '#ff3d3d';
?>
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ComicStream · Google Drive</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #fff4d6 radial-gradient(rgba(20,20,20,.11) 1.3px, transparent 1.7px) 0 0 / 15px 15px; color: #141414; }
.card { max-width: 440px; margin: 20px; padding: 28px 30px; text-align: center; background: #fff; border: 3px solid #141414; border-radius: 10px; box-shadow: 8px 8px 0 #141414; }
h1 { margin: 0 0 12px; font: 400 3rem Impact, 'Arial Black', sans-serif; letter-spacing: .04em; color: <?= $color ?>; -webkit-text-stroke: 1.5px #141414; text-shadow: 3px 3px 0 #141414; }
p { font-weight: 700; line-height: 1.5; }
</style>
</head>
<body>
<div class="card">
<h1><?= htmlspecialchars($title) ?></h1>
<p><?= htmlspecialchars($message) ?></p>
<p><?= $ok ? 'Pode fechar esta aba e voltar ao ComicStream.' : 'Volte ao ComicStream e tente entrar de novo.' ?></p>
</div>
</body>
</html>
