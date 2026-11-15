<?php

declare(strict_types=1);

final class Net
{
    private const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ComicStream';

    private static function caFile(): ?string
    {
        $file = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'cacert.pem';
        return is_file($file) ? $file : null;
    }

    public static function request(string $method, string $url, array $headers = [], ?string $body = null, ?string $sink = null, ?callable $progress = null): array
    {
        if (function_exists('curl_init')) {
            return self::curl($method, $url, $headers, $body, $sink, $progress);
        }
        return self::stream($method, $url, $headers, $body, $sink, $progress);
    }

    public static function json(string $method, string $url, array $headers = [], ?string $body = null): array
    {
        $res = self::request($method, $url, $headers, $body);
        $data = json_decode((string) $res['body'], true);
        return ['status' => $res['status'], 'data' => is_array($data) ? $data : []];
    }

    private static function curl(string $method, string $url, array $headers, ?string $body, ?string $sink, ?callable $progress): array
    {
        $responseHeaders = [];
        $ch = curl_init($url);
        $options = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 10,
            CURLOPT_CONNECTTIMEOUT => 20,
            CURLOPT_TIMEOUT => 0,
            CURLOPT_USERAGENT => self::UA,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_ENCODING => '',
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$responseHeaders): int {
                if (preg_match('#^HTTP/\S+\s+\d+#', $line)) {
                    $responseHeaders = [];
                } elseif (str_contains($line, ':')) {
                    [$k, $v] = explode(':', $line, 2);
                    $responseHeaders[strtolower(trim($k))] = trim($v);
                }
                return strlen($line);
            },
        ];
        $ca = self::caFile();
        if ($ca !== null) {
            $options[CURLOPT_CAINFO] = $ca;
        }
        if ($body !== null) {
            $options[CURLOPT_POSTFIELDS] = $body;
        }
        $fp = null;
        if ($sink !== null) {
            $fp = fopen($sink, 'wb');
            if ($fp === false) {
                throw new HttpError(500, 'Não consegui gravar o download');
            }
            $options[CURLOPT_FILE] = $fp;
            if ($progress !== null) {
                $options[CURLOPT_NOPROGRESS] = false;
                $options[CURLOPT_XFERINFOFUNCTION] = static fn($ch, $total, $now): int => $progress((int) $now, (int) $total) === false ? 1 : 0;
            }
        } else {
            $options[CURLOPT_RETURNTRANSFER] = true;
        }
        curl_setopt_array($ch, $options);
        $result = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $final = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        $error = curl_error($ch);
        curl_close($ch);
        if ($fp) {
            fclose($fp);
        }
        if ($result === false) {
            throw new RuntimeException($error !== '' ? $error : 'Falha de rede');
        }
        return ['status' => $status, 'headers' => $responseHeaders, 'body' => $sink === null ? (string) $result : null, 'url' => $final];
    }

    private static function stream(string $method, string $url, array $headers, ?string $body, ?string $sink, ?callable $progress): array
    {
        $ssl = ['verify_peer' => true];
        $ca = self::caFile();
        if ($ca !== null) {
            $ssl['cafile'] = $ca;
        }
        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", array_merge(['User-Agent: ' . self::UA], $headers)),
                'content' => $body ?? '',
                'follow_location' => 1,
                'max_redirects' => 10,
                'ignore_errors' => true,
                'timeout' => 60,
            ],
            'ssl' => $ssl,
        ]);
        $in = @fopen($url, 'rb', false, $context);
        if ($in === false) {
            throw new RuntimeException('Falha de rede (ative a extensão curl ou openssl do PHP)');
        }
        $meta = stream_get_meta_data($in);
        $status = 0;
        $responseHeaders = [];
        foreach ($meta['wrapper_data'] ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
                $status = (int) $m[1];
                $responseHeaders = [];
            } elseif (str_contains($line, ':')) {
                [$k, $v] = explode(':', $line, 2);
                $responseHeaders[strtolower(trim($k))] = trim($v);
            }
        }
        $total = (int) ($responseHeaders['content-length'] ?? 0);
        if ($sink === null) {
            $data = stream_get_contents($in);
            fclose($in);
            return ['status' => $status, 'headers' => $responseHeaders, 'body' => (string) $data, 'url' => $url];
        }
        $out = fopen($sink, 'wb');
        $done = 0;
        while (!feof($in)) {
            $chunk = fread($in, 262144);
            if ($chunk === false) {
                break;
            }
            fwrite($out, $chunk);
            $done += strlen($chunk);
            if ($progress !== null && $progress($done, $total) === false) {
                break;
            }
        }
        fclose($in);
        fclose($out);
        return ['status' => $status, 'headers' => $responseHeaders, 'body' => null, 'url' => $url];
    }
}
