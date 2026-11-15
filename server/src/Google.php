<?php

declare(strict_types=1);

final class Google
{
    private const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
    private const TOKEN = 'https://oauth2.googleapis.com/token';
    private const SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email';

    private static function data(): array
    {
        return Store::read('google');
    }

    private static function save(callable $change): array
    {
        return Store::update('google', $change);
    }

    private static function base64url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    public static function redirectUri(): string
    {
        $port = (int) ($_SERVER['SERVER_PORT'] ?? 8080);
        return 'http://127.0.0.1:' . $port . '/oauth.php';
    }

    public static function status(): array
    {
        $d = self::data();
        return [
            'configured' => !empty($d['client_id']) && !empty($d['client_secret']),
            'connected' => !empty($d['refresh_token']),
            'email' => $d['email'] ?? '',
            'redirect' => self::redirectUri(),
            'curl' => function_exists('curl_init'),
        ];
    }

    public static function configure(array $input): array
    {
        $id = trim((string) ($input['client_id'] ?? ''));
        $secret = trim((string) ($input['client_secret'] ?? ''));
        if (!preg_match('/^[\w.-]+\.apps\.googleusercontent\.com$/', $id)) {
            throw new HttpError(400, 'O Client ID precisa terminar com .apps.googleusercontent.com');
        }
        if (strlen($secret) < 10) {
            throw new HttpError(400, 'Client secret inválido');
        }
        self::save(static fn(): array => ['client_id' => $id, 'client_secret' => $secret]);
        return self::status();
    }

    public static function loginUrl(): array
    {
        $d = self::data();
        if (empty($d['client_id'])) {
            throw new HttpError(400, 'Configure o Client ID primeiro');
        }
        $verifier = self::base64url(random_bytes(48));
        $state = bin2hex(random_bytes(12));
        $redirect = self::redirectUri();
        self::save(static function (array $data) use ($verifier, $state, $redirect): array {
            $data['verifier'] = $verifier;
            $data['state'] = $state;
            $data['redirect'] = $redirect;
            return $data;
        });
        $query = http_build_query([
            'client_id' => $d['client_id'],
            'redirect_uri' => $redirect,
            'response_type' => 'code',
            'scope' => self::SCOPE,
            'access_type' => 'offline',
            'prompt' => 'consent',
            'state' => $state,
            'code_challenge' => self::base64url(hash('sha256', $verifier, true)),
            'code_challenge_method' => 'S256',
        ]);
        return ['url' => self::AUTH . '?' . $query];
    }

    public static function callback(array $query): string
    {
        $d = self::data();
        if (!empty($query['error'])) {
            throw new HttpError(400, 'O Google recusou o acesso: ' . (string) $query['error']);
        }
        if (empty($query['code']) || ($query['state'] ?? '') !== ($d['state'] ?? null)) {
            throw new HttpError(400, 'Resposta de login inválida. Tente entrar de novo pelo app.');
        }
        $res = Net::json('POST', self::TOKEN, ['Content-Type: application/x-www-form-urlencoded'], http_build_query([
            'code' => (string) $query['code'],
            'client_id' => $d['client_id'],
            'client_secret' => $d['client_secret'],
            'redirect_uri' => $d['redirect'] ?? self::redirectUri(),
            'grant_type' => 'authorization_code',
            'code_verifier' => $d['verifier'] ?? '',
        ]));
        $t = $res['data'];
        if (empty($t['access_token'])) {
            throw new HttpError(400, 'Não consegui concluir o login: ' . ($t['error_description'] ?? $t['error'] ?? 'erro desconhecido'));
        }
        $email = '';
        $me = Net::json('GET', 'https://www.googleapis.com/oauth2/v3/userinfo', ['Authorization: Bearer ' . $t['access_token']]);
        $email = (string) ($me['data']['email'] ?? '');
        self::save(static function (array $data) use ($t, $email): array {
            $data['access_token'] = $t['access_token'];
            $data['expires_at'] = time() + (int) ($t['expires_in'] ?? 3600) - 60;
            if (!empty($t['refresh_token'])) {
                $data['refresh_token'] = $t['refresh_token'];
            }
            $data['email'] = $email;
            unset($data['verifier'], $data['state']);
            return $data;
        });
        return $email;
    }

    public static function token(): string
    {
        $d = self::data();
        if (empty($d['refresh_token'])) {
            throw new HttpError(401, 'Entre com sua conta Google primeiro');
        }
        if (!empty($d['access_token']) && (int) ($d['expires_at'] ?? 0) > time()) {
            return (string) $d['access_token'];
        }
        $res = Net::json('POST', self::TOKEN, ['Content-Type: application/x-www-form-urlencoded'], http_build_query([
            'client_id' => $d['client_id'],
            'client_secret' => $d['client_secret'],
            'refresh_token' => $d['refresh_token'],
            'grant_type' => 'refresh_token',
        ]));
        $t = $res['data'];
        if (empty($t['access_token'])) {
            throw new HttpError(401, 'A sessão do Google expirou. Entre de novo.');
        }
        self::save(static function (array $data) use ($t): array {
            $data['access_token'] = $t['access_token'];
            $data['expires_at'] = time() + (int) ($t['expires_in'] ?? 3600) - 60;
            return $data;
        });
        return (string) $t['access_token'];
    }

    public static function logout(): array
    {
        self::save(static function (array $data): array {
            unset($data['refresh_token'], $data['access_token'], $data['expires_at'], $data['email']);
            return $data;
        });
        return self::status();
    }
}
