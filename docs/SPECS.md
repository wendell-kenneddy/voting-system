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
- Quando a enquete é encerrada, o servidor envia um único evento `closed` com o ranking final (`status: "closed"`, `closedAt` e `updatedAt` iguais ao timestamp de encerramento) e em seguida encerra a conexão:

```
id: <version>
event: closed
data: <JSON do ranking final>

```

- Se a enquete já estiver encerrada no momento da conexão, o servidor responde `200`, envia apenas o evento `closed` e encerra a conexão.
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

**RN-10: Encerramento dos streams.** Ao encerrar, cada cliente conectado recebe exatamente um evento `closed` com o ranking final, incluindo mudanças ainda retidas pelo throttling (em até 500 ms, sem esperar o intervalo), e o servidor encerra a conexão. Nenhum evento `ranking` é emitido depois. O evento `closed` não está sujeito ao throttling da RN-04.

**RN-11: Recursos após o encerramento.** O encerramento libera os temporizadores e as conexões da enquete, inclusive o temporizador do encerramento automático quando a enquete é encerrada manualmente antes do prazo. A enquete encerrada continua consultável por `GET /polls/:pollId` e pelo stream (somente o evento `closed`).

## 6. Requisitos não funcionais

- **Carga:** o sistema deve aceitar uma rajada de 1.000 votos distribuídos em 5 enquetes ao longo de cerca de 2 segundos, sem perda de votos e sem erros `5xx`.
- **Latência de emissão:** o evento inicial do stream (snapshot) e o evento final (`closed`) chegam em até 500 ms; atualizações `ranking` fora da janela de throttling saem em até 300 ms.
- **Memória:** os recursos por conexão SSE e por enquete são liberados quando deixam de ser necessários.
- **Testes:** o projeto é entregue com testes automatizados executáveis por `npm test`.

## 7. Critérios de aceitação

Cada critério é verificável por uma suíte externa que usa apenas HTTP e SSE, sem acessar o código.

**AC-01: Criar e consultar enquete.** Dado um corpo válido, quando `POST /polls`, então retorna `201` com `id`; e `GET /polls/:id` retorna `200` com todas as opções, cada uma com `0` votos, `version: 0`, `totalVotes: 0`, `status: "open"` e `closesAt: null`.

**AC-02: Validação da enquete.** Dado um corpo com menos de 2 opções, opções repetidas, título vazio ou JSON malformado, quando `POST /polls`, então retorna `400` com `error: "INVALID_POLL"`.

**AC-03: Voto aceito.** Dada uma enquete, quando chega um voto válido, então a resposta é `202` e `GET /polls/:id` já mostra a opção com `+1` voto e `version` incrementada.

**AC-04: Ordenação.** Dadas opções com contagens diferentes, então o ranking vem em ordem decrescente de votos; em empate, na ordem de declaração das opções; e `position` começa em `1`.

**AC-05: Voto duplicado.** Dado um voto já aceito, quando chega outro com o mesmo `voteId` na mesma enquete, então a resposta é `200` com `status: "duplicate"`, o ranking não muda e nenhum evento é emitido no stream.

**AC-06: Duplicados concorrentes.** Quando 20 requisições simultâneas enviam o mesmo `voteId`, então exatamente uma recebe `202`, as demais recebem `200`, e o ranking soma apenas `1` voto.

**AC-07: `voteId` entre enquetes.** Dado um `voteId` usado na enquete A, quando o mesmo `voteId` é enviado à enquete B, então ele é aceito (`202`).

**AC-08: Limite por usuário.** Dado um usuário com `MAX_VOTES_PER_USER` votos aceitos na enquete, quando envia um voto com novo `voteId`, então recebe `409` com `error: "USER_VOTE_LIMIT"` e o ranking não muda. Outro usuário continua votando normalmente, e o mesmo usuário ainda pode votar em outra enquete.

**AC-09: Duplicado não consome limite.** Dado um usuário com `MAX_VOTES_PER_USER - 1` votos, quando reenvia um `voteId` já aceito e depois envia um voto novo, então o voto novo é aceito.

**AC-10: Erros de voto.** Quando o voto é enviado a enquete inexistente, recebe `404` (`POLL_NOT_FOUND`); com opção desconhecida, `422` (`UNKNOWN_OPTION`); com campos ausentes ou JSON malformado, `400` (`INVALID_VOTE`).

**AC-11: Snapshot inicial.** Dada uma enquete com 5 votos, quando um cliente abre o stream, então recebe em até 500 ms um evento `ranking` com `totalVotes: 5`. Para uma enquete sem votos, recebe o snapshot com `totalVotes: 0`.

**AC-12: Evento por mudança.** Dado um cliente conectado e sem atividade recente, quando um voto é aceito, então o cliente recebe um evento `ranking` em até 300 ms com o ranking atualizado.

**AC-13: Throttling.** Dado um cliente conectado, quando 100 votos válidos são enviados em menos de 500 ms, então o cliente recebe no máximo 2 eventos `ranking` além do snapshot, o último com `totalVotes: 100` e `version: 100`, em até `RANKING_THROTTLE_MS + 500 ms` após o último voto.

**AC-14: Intervalo entre eventos.** Durante votação contínua por 5 segundos, o intervalo entre dois eventos `ranking` consecutivos (excluindo o snapshot) é de pelo menos `RANKING_THROTTLE_MS - 100 ms`.

**AC-15: Vários clientes.** Dados 3 clientes conectados à mesma enquete, quando votos são enviados, então os três recebem a mesma sequência de eventos (mesmos valores de `version` e `ranking`).

**AC-16: Isolamento entre enquetes.** Dadas as enquetes A e B com clientes conectados em ambas, quando votos são enviados somente à A, então o stream da B não recebe eventos `ranking` e o `GET` da B permanece inalterado.

**AC-17: Resiliência a requisições inválidas.** Dado um cliente conectado, quando 10 requisições inválidas (JSON malformado, campos ausentes, opção desconhecida) são enviadas e depois um voto válido, então o voto é aceito e o cliente continua recebendo eventos.

**AC-18: Desconexão.** Dados 2 clientes conectados, quando um deles encerra a conexão e votos continuam chegando, então o outro continua recebendo eventos e o servidor segue aceitando votos.

**AC-19: Consistência sob carga.** Quando 1.000 votos (todos com `voteId` e `userId` distintos) são enviados em paralelo a 5 enquetes, então todos recebem `202`, e para cada enquete a soma das contagens do `GET` é igual ao número de votos enviados a ela.

**AC-20: Stream de enquete inexistente.** Quando `GET /polls/inexistente/stream`, então retorna `404` com `error: "POLL_NOT_FOUND"`.

**AC-21: Health.** `GET /health` retorna `200` com `{ "status": "ok" }`.

**AC-22: Encerramento manual.** Dada uma enquete aberta com votos, quando `POST /polls/:id/close`, então retorna `200` com `status: "closed"`, `closedAt` e o ranking final; e `GET /polls/:id` retorna `status: "closed"` com as mesmas contagens.

**AC-23: Encerramento idempotente.** Dada uma enquete já encerrada, quando `POST /polls/:id/close` é chamado de novo, então retorna 200 com o mesmo `closedAt` da primeira chamada.

**AC-24: Voto após o encerramento.** Dada uma enquete encerrada, quando chega qualquer voto (inclusive com `voteId` já aceito ou de usuário no limite), então a resposta é `409` com `error: "POLL_CLOSED"` e o ranking não muda.

**AC-25: Evento final no stream.** Dados 2 clientes conectados, quando a enquete é encerrada, então cada um recebe exatamente um evento `closed` com o ranking final (`status: "closed"`, `totalVotes` igual ao do `GET`) e o servidor encerra a conexão em até 500 ms. Nenhum evento `ranking` chega depois do `closed`.

**AC-26: Mudanças retidas pelo throttling.** Dado um cliente conectado com mudanças ainda retidas pelo throttling, quando a enquete é encerrada, então o evento `closed` chega em até 500 ms, sem esperar o intervalo, já com o estado mais recente.

**AC-27: Conexão a enquete encerrada.** Dada uma enquete encerrada, quando um cliente abre o stream, então recebe `200` com um único evento `closed` imediato e a conexão é encerrada pelo servidor.

**AC-28: Encerramento automático.** Dada uma enquete criada com `durationSeconds: 2`, então a resposta de criação traz `closesAt` cerca de 2 s no futuro e `status: "open"`; passados 2 s (tolerância de 500 ms), `GET` retorna `status: "closed"`, os clientes conectados recebem `closed` e novos votos recebem 409.

**AC-29: Validação de `durationSeconds`.** Quando `POST /polls` recebe `durationSeconds` igual a `0`, negativo, maior que `86400` ou não inteiro, então retorna `400` com `error: "INVALID_POLL"`.

**AC-30: Encerramento concorrente a votos.** Quando 200 votos são enviados em paralelo enquanto `POST /polls/:id/close` é chamado, então cada voto recebe 202 ou 409; o `totalVotes` do ranking final é igual ao número de respostas 202; e nenhum voto é aceito depois do encerramento.

**AC-31: Isolamento do encerramento.** Dadas as enquetes A e B abertas, quando a A é encerrada, então a B continua aceitando votos e seu stream continua emitindo eventos `ranking`.

**AC-32: Encerrar enquete inexistente.** Quando `POST /polls/inexistente/close`, então retorna `404` com `error: "POLL_NOT_FOUND"`.

## 8. Fora do escopo

Autenticação e autorização (inclusive controle de quem pode encerrar uma enquete: qualquer cliente pode), persistência em disco ou banco, múltiplas instâncias do servidor, reconexão com `Last-Event-ID` e reenvio de eventos perdidos, reabertura de enquetes, remoção ou expiração de enquetes encerradas da memória, interface gráfica.

## 9. Entregáveis

- Código-fonte em TypeScript.
- Testes automatizados executáveis por `npm test`.
- `package.json` com os scripts `start` e `test`.