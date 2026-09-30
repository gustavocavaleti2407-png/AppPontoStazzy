# Como colocar o App de Ponto Stazzy no ar (Neon + Render, grátis)

Tempo estimado: 15 minutos. Você vai precisar só da sua conta do GitHub.

---

## Parte 1: criar o banco de dados no Neon

1. Acesse **https://neon.com** e clique em **Sign up** (ou *Get started*).
2. Escolha **Continue with GitHub** e autorize.
3. Se ele pedir para criar uma organização, pode aceitar o nome sugerido.
4. Na tela **Create project**, preencha:
   - **Project name:** `stazzy-ponto`
   - **Postgres version:** deixe a que vier marcada
   - **Region:** escolha **AWS São Paulo (sa-east-1)**. Se não aparecer, escolha a mais próxima (ex.: US East).
5. Clique em **Create project**.
6. Na página do projeto, clique no botão **Connect** (canto superior direito do painel).
7. Na janela que abrir, deixe as opções como estão e copie a **connection string**. Ela é parecida com:
   `postgresql://neondb_owner:XXXXXXXX@ep-algo-123456.sa-east-1.aws.neon.tech/neondb?sslmode=require`
   - Se aparecer um botão **Show password**, clique nele antes de copiar, para a senha vir junto.
   - Se o texto vier com `psql '...'` em volta, copie só a parte que começa em `postgresql://` e termina antes da aspa.
8. Guarde esse texto num bloco de notas por alguns minutos. **Não mande para ninguém nem cole na conversa**: ele é a senha do seu banco.

Pronto, o banco está criado. As tabelas são criadas sozinhas quando o app rodar pela primeira vez.

---

## Parte 2: publicar o app no Render

1. Acesse **https://render.com** e clique em **Get Started** (ou *Sign in*).
2. Escolha **GitHub** e autorize.
3. No painel, clique em **New +** (canto superior direito) e depois em **Blueprint**.
4. Se o repositório **AppPontoStazzy** não aparecer na lista:
   - clique em **Configure account** / **Connect GitHub**;
   - na página do GitHub, escolha **Only select repositories**, marque **AppPontoStazzy** e clique em **Save** (ou *Install*);
   - volte ao Render.
5. Clique em **Connect** ao lado de **AppPontoStazzy**.
6. Em **Blueprint Name**, escreva `stazzy-ponto`. Deixe o branch como **main**.
7. O Render vai ler o arquivo `render.yaml` do repositório e mostrar o serviço **stazzy-ponto** no plano **Free**. Mais abaixo, ele pede duas informações:
   - **DATABASE_URL:** cole a connection string do Neon (Parte 1, passo 7).
   - **ADMIN_PASSWORD:** crie a senha do administrador do app (mínimo 6 caracteres). Anote em lugar seguro.
8. Clique em **Apply** (ou *Deploy Blueprint*).
9. Clique no serviço **stazzy-ponto** para acompanhar. A primeira publicação leva de 3 a 5 minutos. Quando terminar, aparece **Live** em verde e, nos logs, a linha `Ponto rodando em ...`.
10. No topo da página do serviço aparece o endereço do app, algo como **https://stazzy-ponto.onrender.com**. Esse é o link que os funcionários vão usar.

---

## Parte 3: primeiro acesso

1. Abra o endereço do app.
2. Entre com login **admin** e a senha que você criou no passo 7 da Parte 2.
3. Em **Configurações**: confira as regras (tolerância, hora extra, intervalo) e cadastre os feriados.
4. Em **Funcionários > Novo funcionário**: cadastre cada funcionário com login, senha inicial, jornada e dias de trabalho.
5. Passe para cada funcionário o endereço do app, o login e a senha. Peça para trocarem a senha na aba **Conta**.

**No celular:** abra o endereço no navegador e use **Adicionar à tela inicial** (Chrome: menu ⋮; iPhone/Safari: botão Compartilhar). O app fica com ícone, como um aplicativo normal.

---

## Parte 4 (recomendada): manter o app sempre acordado

No plano grátis, o Render "dorme" o app depois de 15 minutos sem uso, e o primeiro acesso depois disso demora cerca de 1 minuto. Para evitar:

1. Acesse **https://uptimerobot.com** e crie uma conta grátis.
2. Clique em **New monitor** (ou *Add New Monitor*).
3. Preencha:
   - **Monitor type:** HTTP(s)
   - **Friendly name:** Stazzy Ponto
   - **URL:** o endereço do app com `/health` no final, ex.: `https://stazzy-ponto.onrender.com/health`
   - **Monitoring interval:** 5 minutos
4. Clique em **Create monitor**.

Isso também avisa você por e-mail se o app sair do ar. As 750 horas grátis por mês do Render cobrem o mês inteiro ligado.

---

## Se algo der errado

- **O deploy falhou no Render:** abra o serviço, clique em **Logs** e copie as últimas linhas (sem a connection string) para mim.
- **Erro "Falha ao iniciar o banco de dados":** a `DATABASE_URL` está errada. No Render, vá em **Environment**, corrija o valor e clique em **Save Changes**; o app reinicia sozinho.
- **Esqueci a senha do admin:** a senha só é usada na primeira vez que o banco é criado. Me avise que eu te ajudo a redefinir.
- **Atualizações do app:** quando eu mudar o código no GitHub, o Render publica a nova versão sozinho em poucos minutos.
