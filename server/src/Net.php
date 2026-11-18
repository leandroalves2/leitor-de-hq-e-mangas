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
            CURLOPT_TIMEOUT => $sink === null ? 90 : 0,
            CURLOPT_LOW_SPEED_LIMIT => 1,
            CURLOPT_LOW_SPEED_TIME => 60,
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

    public static function multi(array $queue, int $limit, callable $onDone, ?callable $onTick = null): void
    {
        $queue = array_values($queue);
        if (!function_exists('curl_multi_init')) {
            self::multiSequential($queue, $onDone, $onTick);
            return;
        }
        $mh = curl_multi_init();
        $running = [];
        $fill = static function () use (&$queue, &$running, $mh, $limit): void {
            while ($queue && count($running) < $limit) {
                $req = array_shift($queue);
                $state = (object) ['headers' => [], 'body' => '', 'fp' => null];
                $ch = curl_init((string) $req['url']);
                $options = [
                    CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
                    CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_MAXREDIRS => 10,
                    CURLOPT_CONNECTTIMEOUT => 20,
                    CURLOPT_LOW_SPEED_LIMIT => 1,
                    CURLOPT_LOW_SPEED_TIME => 60,
                    CURLOPT_USERAGENT => self::UA,
                    CURLOPT_HTTPHEADER => $req['headers'] ?? [],
                    CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use ($state): int {
                        if (preg_match('#^HTTP/\S+\s+\d+#', $line)) {
                            $state->headers = [];
                        } elseif (str_contains($line, ':')) {
                            [$k, $v] = explode(':', $line, 2);
                            $state->headers[strtolower(trim($k))] = trim($v);
                        }
                        return strlen($line);
                    },
                ];
                $ca = self::caFile();
                if ($ca !== null) {
                    $options[CURLOPT_CAINFO] = $ca;
                }
                if (!empty($req['range'])) {
                    $options[CURLOPT_RANGE] = $req['range'];
                } else {
                    $options[CURLOPT_ENCODING] = '';
                }
                if (!empty($req['sink'])) {
                    $state->fp = fopen((string) $req['sink'], 'wb');
                    if ($state->fp === false) {
                        $state->fp = null;
                        $options[CURLOPT_WRITEFUNCTION] = static fn($ch, string $data): int => 0;
                    } else {
                        $options[CURLOPT_FILE] = $state->fp;
                    }
                    $options[CURLOPT_TIMEOUT] = 0;
                } elseif (!empty($req['discard'])) {
                    $options[CURLOPT_WRITEFUNCTION] = static fn($ch, string $data): int => strlen($data);
                    $options[CURLOPT_TIMEOUT] = 0;
                } else {
                    $cap = (int) ($req['cap'] ?? 0);
                    $options[CURLOPT_TIMEOUT] = 90;
                    $options[CURLOPT_WRITEFUNCTION] = static function ($ch, string $data) use ($state, $cap): int {
                        $state->body .= $data;
                        return ($cap > 0 && strlen($state->body) > $cap) ? 0 : strlen($data);
                    };
                }
                curl_setopt_array($ch, $options);
                curl_multi_add_handle($mh, $ch);
                $running[spl_object_id($ch)] = ['req' => $req, 'ch' => $ch, 'state' => $state];
            }
        };
        $fill();
        while ($running) {
            do {
                $code = curl_multi_exec($mh, $still);
            } while ($code === CURLM_CALL_MULTI_PERFORM);
            if ($still > 0 && curl_multi_select($mh, 0.2) === -1) {
                usleep(50000);
            }
            while ($info = curl_multi_info_read($mh)) {
                $id = spl_object_id($info['handle']);
                if (!isset($running[$id])) {
                    continue;
                }
                $entry = $running[$id];
                $ch = $entry['ch'];
                $state = $entry['state'];
                $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                $size = (int) curl_getinfo($ch, CURLINFO_SIZE_DOWNLOAD);
                $error = $info['result'] !== CURLE_OK ? curl_error($ch) : '';
                if ($error !== '' && $status > 0 && !empty($entry['req']['cap'])) {
                    $error = '';
                }
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
                if ($state->fp) {
                    fclose($state->fp);
                }
                unset($running[$id]);
                $more = $onDone($entry['req'], ['status' => $status, 'headers' => $state->headers, 'body' => $state->body, 'error' => $error, 'bytes' => $size]);
                if (is_array($more)) {
                    $queue[] = $more;
                }
            }
            $fill();
            if ($onTick !== null) {
                $bytes = [];
                foreach ($running as $entry) {
                    $bytes[$entry['req']['key'] ?? spl_object_id($entry['ch'])] = (int) curl_getinfo($entry['ch'], CURLINFO_SIZE_DOWNLOAD);
                }
                if ($onTick($bytes) === false) {
                    foreach ($running as $entry) {
                        curl_multi_remove_handle($mh, $entry['ch']);
                        curl_close($entry['ch']);
                        if ($entry['state']->fp) {
                            fclose($entry['state']->fp);
                        }
                    }
                    $running = [];
                    $queue = [];
                }
            }
        }
        curl_multi_close($mh);
    }

    private static function multiSequential(array $queue, callable $onDone, ?callable $onTick): void
    {
        while ($queue) {
            $req = array_shift($queue);
            if (!empty($req['discard'])) {
                $onDone($req, ['status' => 0, 'headers' => [], 'body' => '', 'error' => 'sem curl', 'bytes' => 0]);
                continue;
            }
            $headers = $req['headers'] ?? [];
            if (!empty($req['range'])) {
                $headers[] = 'Range: bytes=' . $req['range'];
            }
            try {
                $res = self::stream('GET', (string) $req['url'], $headers, null, $req['sink'] ?? null, null);
                $more = $onDone($req, ['status' => $res['status'], 'headers' => $res['headers'], 'body' => substr((string) ($res['body'] ?? ''), 0, 65536), 'error' => '', 'bytes' => 0]);
            } catch (Throwable $e) {
                $more = $onDone($req, ['status' => 0, 'headers' => [], 'body' => '', 'error' => $e->getMessage(), 'bytes' => 0]);
            }
            if (is_array($more)) {
                $queue[] = $more;
            }
            if ($onTick !== null && $onTick([]) === false) {
                return;
            }
        }
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
