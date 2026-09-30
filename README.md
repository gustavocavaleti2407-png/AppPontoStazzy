# Ponto — controle de ponto para pequenas empresas

App web responsivo (funciona no celular e no computador, e pode ser instalado na tela inicial como app).
Feito para empresas de até 10 funcionários.

## O que tem

**Funcionário**
- Botão único para registrar o ponto (entrada, saída para intervalo, volta, saída). O horário vem do servidor, não do aparelho.
- Resumo do dia: horas trabalhadas, intervalo e hora extra.
- Espelho de ponto do mês, com download em PDF e Excel.

**Administrador**
- Painel do dia: quem já registrou, quem está trabalhando.
- Cadastro de funcionários com jornada diária e dias de trabalho.
- Relatórios por funcionário ou de todos, em PDF (com campo de assinatura) e Excel (aba de resumo + uma aba por funcionário).
- Ajuste de marcações (incluir, alterar, excluir) sempre com justificativa, registrado no histórico de ajustes.
- Regras e feriados configuráveis.

## Regras aplicadas (padrão CLT, todas editáveis em Configurações)

| Regra | Padrão |
|---|---|
| Tolerância diária (art. 58 §1º) | até 10 min de diferença no dia não conta como extra nem débito |
| Hora extra em dia normal | adicional de 50% |
| Hora extra em domingo e feriado | adicional de 100% |
| Limite de hora extra | alerta acima de 2h por dia |
| Intervalo (art. 71) | jornada acima de 6h exige 1h; de 4h a 6h exige 15 min; alerta se passar de 2h. O tempo que faltou aparece como "intervalo suprimido" |
| Interjornada (art. 66) | alerta se houver menos de 11h entre um dia e outro |
| Adicional noturno | horas entre 22h e 5h são somadas à parte |
| Faltas e débito | dia de trabalho sem marcação conta como falta; horas abaixo da jornada viram débito |
| Banco de horas | saldo = horas extras − débitos no período |

Trabalho em sábado, domingo ou feriado fora da escala do funcionário conta integralmente como hora extra.

## Rodar localmente

Precisa de Node.js 22.13 ou mais novo.

```bash
npm install
npm start
```

Abra http://localhost:3000. Login inicial: `admin` / `admin123` (troque na aba Conta).
Para definir outro login inicial: `ADMIN_LOGIN=joao ADMIN_PASSWORD=senhaforte npm start`.

## Banco de dados

- Com a variável `DATABASE_URL` definida, o app usa **Postgres** (por exemplo, o Neon gratuito).
- Sem ela, usa **SQLite** num arquivo em `DATA_DIR` (bom para testar localmente ou num servidor com disco próprio).

As tabelas são criadas automaticamente na primeira execução.

## Hospedar na nuvem de graça: Render + Neon

1. **Banco (Neon):** crie uma conta em neon.com, crie um projeto na região São Paulo (ou a mais próxima) e copie a *connection string* (`postgresql://...`).
2. **Código:** coloque esta pasta num repositório do GitHub.
3. **App (Render):** em render.com, *New > Blueprint*, escolha o repositório (o arquivo `render.yaml` já configura tudo no plano gratuito). Quando pedir, preencha:
   - `DATABASE_URL`: a connection string do Neon
   - `ADMIN_PASSWORD`: a senha inicial do administrador
4. **Manter acordado (opcional):** o plano grátis do Render pausa o app após 15 min sem uso e o primeiro acesso depois disso leva cerca de 1 minuto. Para evitar, crie um monitor gratuito (ex.: cron-job.org ou UptimeRobot) que acesse `https://SEU-APP.onrender.com/health` a cada 10 minutos. As 750 horas grátis do Render cobrem o mês inteiro ligado.

Limites gratuitos: Neon com 0,5 GB de dados (suficiente para anos de ponto de 10 pessoas); Render com 512 MB de memória.

## Outras hospedagens

O `Dockerfile` roda em qualquer lugar. Sem `DATABASE_URL`, monte um volume persistente em `/data` (Railway, Fly.io, servidor próprio, Oracle Cloud Always Free).

Variáveis de ambiente:

| Variável | Uso |
|---|---|
| `DATABASE_URL` | conexão Postgres (se vazio, usa SQLite) |
| `DATA_DIR` | pasta do SQLite (no Docker: `/data`) |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | administrador criado na primeira execução |
| `TZ` | fuso horário (padrão `America/Sao_Paulo`) |
| `PORT` | porta HTTP (padrão 3000) |

**Backup:** o Neon guarda histórico de restauração; no SQLite, copie o arquivo `ponto.db` periodicamente.

## Observações legais

Empresas com até 20 funcionários não são obrigadas a controlar ponto (CLT art. 74 §2º), mas quando usam ponto eletrônico como registro oficial a Portaria MTP 671/2021 pede requisitos extras para sistemas via programa (REP-P), como comprovante ao funcionário e arquivo AFD. Este protótipo cobre o controle interno de jornada; confirme com o contador se a empresa precisa desses itens.
