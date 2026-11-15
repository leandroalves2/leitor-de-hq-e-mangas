# ComicStream

Leitor de HQs, mangás e PDFs com visual pop art. Ele roda localmente com PHP puro e não precisa de banco de dados, Node nem internet.

## Instalar no PC e no Android (sem navegador)

O GitHub monta os instaladores sozinho a cada envio:

1. Instale o **GitHub Desktop** (desktop.github.com) e entre na sua conta.
2. **File → Add local repository** → escolha esta pasta (`meu-leitor-hq`). Se ele perguntar, clique em "create a repository".
3. Escreva um resumo (ex.: "primeira versão"), clique em **Commit to main** e depois em **Publish repository** (ou **Push origin**, se o repositório já existir).
4. No site do GitHub, abra o repositório → aba **Actions** → "Gerar instaladores". Espere ficar verde (uns 10 minutos).
5. Clique na execução e, em **Artifacts**, baixe:
   - **ComicStream-Windows**: dentro dele está o `ComicStream-Setup-1.0.0.exe`. Execute para instalar. Se o Windows avisar "aplicativo não reconhecido", clique em *Mais informações → Executar assim mesmo*.
   - **ComicStream-Android**: dentro dele está o `ComicStream.apk`. Copie para o celular e abra. Permita "instalar apps desconhecidos" quando o Android pedir.

As pastas `uploads/` (suas HQs) e `storage/` **não** sobem para o GitHub.

### Onde ficam as HQs

- **App do PC**: `Documentos\ComicStream`. Dá para trocar em ⚙ Configurações.
- **App Android**: `Android/data/com.comicstream.app/files/ComicStream/Biblioteca`. Copie pelo cabo USB ou use os botões **Enviar** e **Drive**.

## Google Drive

- **Link público**: botão **Drive** → cole o link de um arquivo ou pasta compartilhada como "qualquer pessoa com o link". Tudo vai para a pasta **Downloads** da estante, em segundo plano.
- **Minha conta (PC)**: na aba "Minha conta", siga os 5 passos para criar um *ID do cliente OAuth* do tipo **App para computador** no Google Cloud (grátis), cole o ID e a chave, e clique em **Entrar com Google**. O login abre no navegador.
- **Minha conta (Android)**: o botão abre o seletor de arquivos do Android, que já mostra o Drive da conta logada no celular.

## Como rodar (modo navegador, sem instalar)

1. Instale o **PHP 8.0 ou mais novo** (ou o XAMPP) e deixe o `php` no PATH.
2. Dê dois cliques em **`iniciar.bat`**. O navegador abre em `http://localhost:8080`.
3. Para ler pelo celular na mesma rede Wi-Fi, use **`iniciar-rede.bat`** e acesse `http://IP-DO-PC:8080`.

No Linux ou no macOS, rode `./iniciar.sh` (ou `./iniciar.sh rede`).

Com XAMPP/Apache, aponte o DocumentRoot para a pasta `public/`. Os limites de upload já estão no `public/.user.ini`.

## Biblioteca

- Coloque suas HQs na pasta **`uploads/`**, com quantas subpastas quiser, ou envie pelo botão **Enviar**. Também dá para arrastar arquivos e pastas para a janela.
- A estante se atualiza sozinha quando você volta para a janela, e o botão ↻ força a atualização.
- As capas são geradas uma única vez e ficam em cache em `storage/thumbs`.
- O progresso de leitura fica em `storage/progress.json`, e por isso é compartilhado entre o PC e o celular.

## Formatos

| Formato | Como é lido |
|---|---|
| PDF | pdf.js com leitura por faixas (Range): abre na hora, mesmo com arquivos grandes |
| CBZ / ZIP | extensão `zip` do PHP, uma página por vez |
| CBR / RAR / CB7 / 7Z | 7-Zip instalado (detectado automaticamente) ou extensão `rar` do PHP |
| JPG, PNG, WEBP, GIF, AVIF | imagens da mesma pasta viram uma sequência |

Para ler CBR, instale o [7-Zip](https://www.7-zip.org). Se ele estiver fora do caminho padrão, informe o caminho em `server/config.php`.

## Modos de leitura

- **Página**: clique nas laterais, use as setas ou deslize no celular. O ajuste à tela ou à largura fica na tecla W, e o zoom com arraste no Ctrl + rodinha.
- **Livro**: efeito de folhear com page-flip, mostrando páginas duplas em telas largas.
- **Scroll**: rolagem infinita virtualizada, que só mantém em memória as páginas perto da tela.
- **HQ/Mangá**: inverte a direção de leitura em todos os modos.
- **Capítulos**: lista lateral, avanço automático para o próximo capítulo e tela de "FIM!".

- **Quadro a quadro** (tecla `G`): o leitor detecta os quadros da página e dá zoom em um por vez, com animação. Páginas sem quadros detectáveis aparecem inteiras.
- **Ajustes de imagem** (tecla `I`): brilho, contraste, saturação e sépia, com os presets Noite, Papel limpo e Cores vivas, além do corte automático de margens brancas.
- **Pré-carregamento**: perto do fim do capítulo, o próximo já é carregado e abre na hora.

Aperte `?` dentro do leitor para ver todos os atalhos.

## Estante

- **Favoritos** (estrela no card ou tecla `S` no leitor) e **coleções** (botão + no card).
- **Arrastar para coleção**: arraste qualquer card, de HQ ou de pasta, e solte numa coleção ou em "Nova coleção". Uma pasta adicionada inteira inclui automaticamente as HQs que entrarem nela depois.
- Dentro de uma pasta, o botão **Coleção** ao lado do caminho adiciona a pasta inteira.
- **Apagar** (lixeira no card): o item vai para `storage/lixeira/`. Nada é apagado de vez.
- **Filtros**: Todos, Não lidos, Lendo e Lidos.
- O número da edição (#08) e o título interno do PDF ("Thor V5 08 (2019)") aparecem nos cards.
- **Estatísticas** (ícone de troféu): páginas por dia, sequência de dias, tempo de leitura e 12 conquistas.

## App (PWA)

Abrindo pelo `http://localhost:8080`, o navegador mostra o botão **Instalar** (ícone rosa no topo). Com isso o ComicStream vira um app com ícone próprio e janela sem barra do navegador.

No celular, a instalação como app exige HTTPS. Pela rede local (http://IP:8080), use "Adicionar à tela inicial" do navegador.

## Estrutura

```
public/            frontend (index.html, api.php, oauth.php, assets)
desktop/           app para PC (Electron + PHP embutido)
mobile/            app Android (Capacitor; android/ é o projeto gerado)
.github/workflows/ build automático do .exe e do .apk
  assets/js/       app.js, library.js, reader.js, sources.js, panels.js, stats.js, thumbs.js, upload.js
  sw.js            service worker (app instalável)
  assets/vendor/   pdf.js 3.11.174 e page-flip 2.0.7 (locais, sem CDN)
server/            backend PHP (config.php, src/*.php)
storage/           cache de capas, progresso e extrações (pode apagar)
uploads/           sua biblioteca
```

## API

Todas as rotas passam por `api.php?r=...`:

| Rota | Função |
|---|---|
| `tree` | árvore da biblioteca e progresso |
| `file&p=` | arquivo com suporte a Range |
| `pages&p=` / `page&p=&i=` | páginas de CBZ/CBR |
| `thumb` | lê ou grava a capa em cache |
| `progress` | lê ou grava o progresso |
| `upload` | envio de um arquivo por vez |
| `collections` | favoritos e coleções |
| `meta` | título e número de páginas |
| `stats` | estatísticas de leitura |
| `delete` | move para a lixeira |
| `google*` | credencial, login e status da conta Google |
| `drive-*` | listar o Drive, iniciar, acompanhar e cancelar downloads |

Todos os caminhos são validados para ficar dentro de `uploads/`.
