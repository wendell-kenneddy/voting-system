# Especificação: Leaderboard de Votação ao Vivo

## 1. Visão geral

API backend que recebe votos em várias enquetes e transmite, em tempo real, o ranking atualizado de cada uma via Server-Sent Events (SSE). Não há frontend nem persistência: todo o estado vive em memória.

## 2. Stack e execução

- Node.js 20 ou superior, TypeScript, RxJS e Express.
- Estado em memória (sem banco de dados, sem broker externo).
- `npm install` instala as dependências.
- `npm start` sobe o servidor na porta definida por `PORT` (padrão `3000`).
- `npm test` executa os testes automatizados do projeto de forma autônoma (sem exigir servidor previamente iniciado) e encerra o processo com código `0` ao final, fechando servidores HTTP e temporizadores abertos.

Configuração por variáveis de ambiente:

| Variável | Padrão | Significado |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `MAX_VOTES_PER_USER` | `3` | Máximo de votos aceitos por usuário em uma mesma enquete |
| `RANKING_THROTTLE_MS` | `1000` | Intervalo mínimo entre eventos `ranking` de uma mesma enquete |

Nota: valores `0` são válidos para `MAX_VOTES_PER_USER` e `RANKING_THROTTLE_MS` e devem ser respeitados (evite fallbacks baseados em valores *falsy* como `|| 1000`).

## 3. Modelo de dados

**Enquete (poll):** `id` (string gerada pelo servidor), `title` (1 a 200 caracteres) e `options` (2 a 10 strings únicas, não vazias, até 100 caracteres cada), `status` (`open` ou `closed`), `closesAt` (data ISO do encerramento automático, ou `null`) e `closedAt` (data ISO em que foi encerrada, ou `null`).

**Voto (vote):** `voteId` (string não vazia, até 100 caracteres), `userId` (string não vazia, até 100 caracteres) e `option` (uma das opções da enquete).

**Regras de strings:** strings compostas apenas por espaços em branco são consideradas vazias (inválidas), mas nenhum campo sofre `trim` ou normalização automática.

**Ranking:** lista com **todas** as opções da enquete, ordenada por votos em ordem decrescente. Em caso de empate, vale a ordem em que as opções foram declaradas na criação da enquete.

```json
{
  "pollId": "abc123",
  "status": "open",
  "version": 12,
  "totalVotes": 12,
  "ranking": [
    { "position": 1, "option": "TypeScript", "votes": 7 },
    { "position": 2, "option": "Kotlin", "votes": 5 },
    { "position": 3, "option": "Go", "votes": 0 }
  ],
  "updatedAt": "2026-11-20T15:00:00.000Z"
}
```

- `version` é o número de votos aceitos na enquete até o momento (começa em `0` e só cresce).
- `position` começa em `1`.
- Na criação da enquete (`version: 0`), `updatedAt` recebe o timestamp ISO de criação.
- `status` indica se a enquete está aberta (`open`) ou encerrada (`closed`). Enquanto `status` for `open`, `closedAt` é `null` no `GET /polls/:pollId` e omitido nos eventos SSE `ranking`. Quando encerrada (`status: "closed"`), `closedAt` recebe o timestamp ISO do encerramento e `updatedAt` passa a ter o mesmo valor de `closedAt`, garantindo consistência idêntica entre `POST /polls/:pollId/close`, `GET /polls/:pollId` e o evento SSE `closed`.

**Identificação de usuários:** `userId` é um identificador opaco, informado pelo cliente e aceito como verdadeiro (não há autenticação). Dois votos pertencem ao mesmo usuário se, e somente se, os `userId` forem idênticos, comparados exatamente (diferencia maiúsculas de minúsculas, sem normalização). A especificação não impede que uma mesma pessoa use vários `userId`; esse tipo de fraude está fora do escopo.

## 4. API HTTP

Toda resposta de erro usa o formato `{ "error": "CODIGO", "message": "texto livre" }`. Requisições e respostas usam JSON, exceto o stream SSE.

Corpos JSON que não sejam objetos (ex.: arrays, strings, números ou `null`) são tratados como corpo inválido (`400`). Erros de sintaxe no parsing do JSON devem sempre retornar resposta JSON no formato padrão (nunca HTML), usando `INVALID_POLL` em `POST /polls` e `INVALID_VOTE` em `POST /polls/:pollId/votes`.

### 4.1 `POST /polls`

Cria uma enquete. Corpo: `{ "title": string, "options": string[], "durationSeconds"?: number | null }`. Se `durationSeconds` for informado (inteiro de 1 a 86400), a enquete é encerrada automaticamente após esse tempo; se omitido ou `null`, só é encerrada manualmente.

- `201` com `{ "id", "title", "options", "status": "open", "closesAt" }`, onde `closesAt` é a data ISO prevista do encerramento automático ou `null`.
- `400` (`INVALID_POLL`) se o corpo for inválido (título vazio ou só espaços, menos de 2 ou mais de 10 opções, opções repetidas ou vazias, `durationSeconds` fora do intervalo ou não inteiro, payload não-objeto ou JSON malformado).

### 4.2 `GET /polls/:pollId`

Retorna o ranking atual da enquete, no formato da seção 3, acrescido de `title`, `closesAt` e `closedAt`.

- `200` com o ranking.
- `404` (`POLL_NOT_FOUND`) se a enquete não existir.

A resposta reflete **todos** os votos já aceitos (que receberam `202`) antes da requisição. Esta rota não sofre throttling.

### 4.3 `POST /polls/:pollId/votes`

Registra um voto. Corpo: `{ "voteId": string, "userId": string, "option": string }`.

| Situação | Resposta |
|---|---|
| Voto aceito | `202` com `{ "status": "accepted", "voteId": "..." }` |
| `voteId` já registrado nesta enquete | `200` com `{ "status": "duplicate", "voteId": "..." }` |
| Usuário já atingiu `MAX_VOTES_PER_USER` nesta enquete | `409` com `error: "USER_VOTE_LIMIT"` |
| Corpo inválido (campos ausentes, vazios, tipos errados, não-objeto ou JSON malformado) | `400` com `error: "INVALID_VOTE"` |
| Enquete inexistente | `404` com `error: "POLL_NOT_FOUND"` |
| Enquete encerrada | `409` com `error: "POLL_CLOSED"` |
| `option` não pertence à enquete | `422` com `error: "UNKNOWN_OPTION"` |

Ordem de verificação: enquete inexistente (`404`), corpo inválido (`400`), enquete encerrada (`409 POLL_CLOSED`), opção desconhecida (`422`), voto duplicado (`200`) e, por último, limite do usuário (`409 USER_VOTE_LIMIT`).

### 4.4 `GET /polls/:pollId/stream`

Abre um stream SSE (`Content-Type: text/event-stream`) com o ranking da enquete.

- Ao conectar, o servidor envia imediatamente um evento `ranking` com o estado atual (snapshot inicial), mesmo que ainda não haja votos.
- Depois, envia um novo evento `ranking` sempre que o ranking mudar, respeitando as regras de emissão da seção 5.
- Formato de cada evento (terminado por linha em branco `\n\n`):

```
id: <version>
event: ranking
data: <JSON do ranking, formato da seção 3>

```

- A cada 15 segundos sem eventos na conexão, o servidor envia uma linha de comentário (`: heartbeat\n\n`) para manter a conexão viva, sem interferir na janela de throttling dos eventos `ranking`.
- Quando a enquete é encerrada, o servidor envia um único evento `closed` com o ranking final (`status: "closed"`, `closedAt` e `updatedAt` iguais ao timestamp de encerramento) e em seguida encerra a conexão (em até 500 ms):

```
id: <version>
event: closed
data: <JSON do ranking final>

```

- Se a enquete já estiver encerrada no momento da conexão, o servidor responde `200`, envia apenas o evento `closed` imediatamente e encerra a conexão.
- `404` (`POLL_NOT_FOUND`) em JSON se a enquete não existir.

### 4.5 `POST /polls/:pollId/close`

Encerra a enquete manualmente. Não tem corpo.

- `200` com o ranking final (formato da seção 3), com `status: "closed"` e `closedAt`.
- Chamar novamente em uma enquete já encerrada também retorna `200`, com o mesmo `closedAt` da primeira chamada.
- `404` (`POLL_NOT_FOUND`) se a enquete não existir.

### 4.6 `GET /health`

Retorna `200` com `{ "status": "ok" }`.

## 5. Regras de negócio

**RN-01: Idempotência.** O par (`pollId`, `voteId`) é registrado uma única vez. Repetições não alteram o ranking, não geram evento e não consomem o limite do usuário. O mesmo `voteId` em enquetes diferentes é independente.

**RN-02: Limite por usuário.** Cada `userId` pode ter no máximo `MAX_VOTES_PER_USER` votos aceitos por enquete. O limite é por enquete: o mesmo usuário pode votar em outras enquetes.

**RN-03: Isolamento.** Cada enquete tem estado, contagem e cadência de emissão independentes. Votos em uma enquete nunca alteram outra nem geram eventos no stream dela. O encerramento de uma enquete também não afeta as demais.

**RN-04: Emissão com throttling.** Para cada enquete, dois eventos `ranking` consecutivos (excluindo o snapshot inicial de cada conexão) ficam separados por pelo menos `RANKING_THROTTLE_MS`, com tolerância de 100 ms. Quando o ranking muda:

- se o intervalo mínimo desde a última emissão já passou, o evento sai imediatamente (em até 300 ms);
- caso contrário, as mudanças são agrupadas e o estado mais recente sai ao fim do intervalo.

Sem mudanças, nenhum evento `ranking` é emitido. Trata-se de throttling com borda inicial (*leading*) e borda final (*trailing*), garantindo que o estado mais recente nunca seja descartado.

**RN-05: Distribuição a vários clientes.** Todos os clientes conectados à mesma enquete recebem a mesma sequência de eventos. O custo de processar um voto não deve crescer com o número de clientes conectados.

**RN-06: Ordem e consistência.** Votos aceitos nunca são perdidos, mesmo enviados em paralelo. As verificações e mutações de estado em memória (status da enquete, duplicidade, limite do usuário e atualização de contagem) devem ser atômicas/síncronas, sem pontos de suspensão assíncrona (`await`) intermediários. Após qualquer rajada de votos, a soma das contagens do ranking é igual ao número de respostas `202` recebidas, e `version` é igual a `totalVotes`.

**RN-07: Resiliência.** Uma requisição inválida ou um erro ao processar um voto não pode encerrar streams abertos nem impedir o processamento dos votos seguintes.

**RN-08: Desconexão.** Quando um cliente SSE se desconecta, o servidor libera os recursos associados a ele sem afetar os demais clientes nem o recebimento de votos.

**RN-09: Encerramento.** Uma enquete é encerrada manualmente (`POST /polls/:pollId/close`) ou automaticamente, ao fim de `durationSeconds` (tolerância de 500 ms). O encerramento é definitivo (não há reabertura) e idempotente (o `closedAt` não muda em chamadas repetidas). Todo voto que recebeu `202` antes do encerramento consta no ranking final, e todo voto processado depois é rejeitado com `409`. Nunca pode existir voto aceito que não conste no ranking final, nem voto contado após o encerramento, mesmo com votos e encerramento concorrentes.

**RN-10: Encerramento dos streams.** Ao encerrar, cada cliente conectado recebe exatamente um evento `closed` com o ranking final, incluindo mudanças ainda retidas pelo throttling (em até 500 ms, sem esperar o intervalo), e o servidor encerra a conexão em até 500 ms. Nenhum evento `ranking` é emitido depois. O evento `closed` não está sujeito ao throttling da RN-04.

**RN-11: Recursos após o encerramento.** O encerramento libera os temporizadores e as conexões da enquete, inclusive o temporizador do encerramento automático quando a enquete é encerrada manualmente antes do prazo. A enquete encerrada continua consultável por `GET /polls/:pollId` e pelo stream (somente o evento `closed`).

## 6. Requisitos não funcionais

- **Carga:** o sistema deve aceitar uma rajada de 1.000 votos distribuídos em 5 enquetes ao longo de cerca de 2 segundos, sem perda de votos e sem erros `5xx`.
- **Latência de emissão:** o evento inicial do stream (snapshot) e o evento final (`closed`) chegam em até 500 ms; atualizações `ranking` fora da janela de throttling saem em até 300 ms.
- **Memória:** os recursos por conexão SSE e por enquete são liberados quando deixam de ser necessários.
- **Testes:** o projeto é entregue com testes automatizados executáveis por `npm test`.

## 7. Fora do escopo

Autenticação e autorização (inclusive controle de quem pode encerrar uma enquete: qualquer cliente pode), persistência em disco ou banco, múltiplas instâncias do servidor, reconexão com `Last-Event-ID` e reenvio de eventos perdidos, reabertura de enquetes, remoção ou expiração de enquetes encerradas da memória, interface gráfica.

## 8. Entregáveis

- Código-fonte em TypeScript.
- Testes automatizados executáveis por `npm test`.
- `package.json` com os scripts `start` e `test`.