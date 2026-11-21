# AGENTS.md — Leaderboard de Votação ao Vivo

API backend (Node 20+, TypeScript, RxJS, Express) que recebe votos em várias enquetes e transmite o ranking em tempo real via SSE. Estado 100% em memória.

**Fonte da verdade funcional:** `SPECS.md` (raiz do repositório). Leia-a inteira antes de escrever código. Este arquivo define *como* trabalhar; a spec define *o quê*. Se houver conflito entre os dois, siga a spec e avise (seção 10).

---

## 1. Comandos

| Comando | O que faz |
|---|---|
| `npm install` | Instala dependências |
| `npm start` | Sobe o servidor (`PORT`, padrão 3000) |
| `npm test` | Roda toda a suíte e **termina com código 0**, sem handles abertos |
| `npm run typecheck` | `tsc --noEmit` em modo strict |
| `npm run lint` | ESLint (inclui `eslint-plugin-rxjs` e regras próprias) |
| `npm run lint:arch` | `dependency-cruiser`: valida direção das dependências entre camadas |
| `npm run lint:openapi` | Valida que `openapi.yaml` é um OpenAPI 3.x válido e cobre todas as rotas (seção 6) |
| `npm run validate` | typecheck + lint + lint:arch + lint:openapi + test. **É o critério de "pronto"** |

### Definição de pronto

Uma tarefa só está concluída quando `npm run validate` passa **sem erros e sem warnings**. Não declare sucesso sem ter rodado o comando e visto a saída.

---

## 2. Arquitetura em camadas

```
openapi.yaml                # documentação da API (OpenAPI 3.x), ver seção 6
src/
  config.ts                 # leitura de env vars (única fonte)
  main.ts                   # composition root: monta tudo e chama listen()
  domain/                   # PURO e SÍNCRONO
    poll.ts                 # entidade Poll + applyVote() + closePoll()
    ranking.ts              # buildRanking() com desempate por ordem de declaração
    validation.ts           # validação de corpo de enquete e de voto
    errors.ts               # códigos de erro como valores (Result), não exceções
  application/              # RxJS vive aqui
    ports.ts                # interfaces: Clock, SchedulerLike, IdGenerator
    pollRegistry.ts         # Map<pollId, PollRuntime>
    pollRuntime.ts          # streams por enquete (votos, ranking$, closed$)
  infra/
    http/
      app.ts                # cria o Express app (sem listen)
      routes.ts             # rotas finas: parse -> chamar application -> mapear resposta
      sse.ts                # escrita do protocolo SSE e heartbeat
      errorHandler.ts       # JSON malformado -> JSON no formato padrão
test/
  unit/                     # domain (sem RxJS, sem rede)
  marble/                   # application com TestScheduler (tempo virtual)
  http/                     # supertest + SSE client, servidor em porta efêmera
```

### Regras de dependência (impostas por `lint:arch`)

- `domain` **não importa** `rxjs`, `express`, `node:*` de tempo/rede, nem `application`/`infra`.
- `application` importa `domain` e `rxjs`. **Não importa** `express` nem `infra`.
- `infra` importa `application` e `domain`. Rotas não contêm regra de negócio.
- Só `main.ts` conhece todas as camadas e instancia implementações concretas (`Date.now`, `asyncScheduler`, `crypto.randomUUID`).

---

## 3. Regras de programação reativa (obrigatórias)

**R1. Um stream por enquete, compartilhado por todos os clientes.**
Cada enquete tem um único pipeline de ranking: `state$ → distinctUntilChanged(version) → throttleTime(RANKING_THROTTLE_MS, scheduler, { leading: true, trailing: true }) → share()`. O ranking é calculado **uma vez por emissão**, antes do `share`, nunca por conexão (RN-05: o custo de um voto não cresce com o número de clientes).

**R2. O throttle é por enquete, não por conexão.**
O snapshot inicial de cada conexão é enviado direto do estado atual e fica **fora** do throttle. Depois dele, a conexão assina o stream compartilhado.

**R3. `closed` ignora o throttle.**
Ao encerrar: o stream `ranking$` é cortado com `takeUntil(closed$)`, e o evento `closed` é emitido imediatamente com o estado mais recente, inclusive mudanças retidas pelo trailing. Nenhum `ranking` pode sair depois de `closed`.

**R4. Proibido `subscribe` aninhado.** Use `switchMap`, `mergeMap`, `concatMap`, `takeUntil` etc.

**R5. Toda subscrição tem dono e é descartada.**
- Subscrições de SSE terminam em `req.on('close')` e quando `closed$` emite.
- Ao encerrar a enquete: completar os Subjects, cancelar o timer de encerramento automático (inclusive no fechamento manual antes do prazo) e liberar o runtime.
- Nunca ignore o retorno de `subscribe()` sem `takeUntil`/`add` num `Subscription`.

**R6. Tempo só via portas.**
`setTimeout`, `setInterval`, `Date.now()` e `new Date()` são proibidos fora de `main.ts` e da implementação concreta do `Clock`. Use `Clock` e `SchedulerLike` injetados. Isso permite testar com `TestScheduler`. Timers reais devem usar `unref()` para não segurar o processo.

**R7. Sem `async` em callbacks de `subscribe` / `tap`.** Erros dentro de operadores são tratados com `catchError` que **não** derruba o stream compartilhado (RN-07).

**R8. Subjects não vazam para fora da camada.** Exponha `Observable` (`asObservable()`), nunca o `Subject`.

**R9. Heartbeat.** `: heartbeat\n\n` após 15 s sem eventos na conexão, implementado como `switchMap` que reinicia o timer a cada evento. Não pode alterar a janela de throttle dos eventos `ranking`.

---

## 4. Regras de domínio e concorrência

**D1. Atomicidade (RN-06).** `applyVote(poll, vote, now)` é **uma função síncrona** que faz, em sequência e sem `await`: checar status, duplicidade, limite do usuário e incrementar a contagem/`version`. Não existe ponto de suspensão entre checar e mutar.

**D2. Ordem de verificação do voto (seção 4.3 da spec).**
`404 POLL_NOT_FOUND` → `400 INVALID_VOTE` → `409 POLL_CLOSED` → `422 UNKNOWN_OPTION` → `200 duplicate` → `409 USER_VOTE_LIMIT` → `202 accepted`.
Consequências desta ordem:
- voto duplicado em enquete **encerrada** retorna `409 POLL_CLOSED`, não `200`;
- `voteId` já registrado mas com `option` desconhecida retorna `422`, não `200`;
- usuário **no limite** reenviando um `voteId` já aceito recebe `200 duplicate`, não `409`.

**D3. Idempotência (RN-01).** Chave `(pollId, voteId)`. Duplicado não altera ranking, não emite evento e **não consome** limite do usuário.

**D4. Config com `??`, nunca `||`.** `0` é valor válido para `MAX_VOTES_PER_USER` e `RANKING_THROTTLE_MS`. Converta com `Number()`. A spec não define o que fazer com valores inválidos (não numéricos, decimais, negativos); como medida defensiva, valide com `Number.isInteger` e `>= 0` e faça o boot falhar com mensagem clara em vez de propagar `NaN`. Não é exigência da spec.

**D5. Strings.** Só-espaços é vazio (inválido), mas **nenhum campo sofre `trim`**. Comparações de `userId`, `voteId` e opções são exatas e sensíveis a maiúsculas.

**D6. Ranking.** Contém **todas** as opções, ordem decrescente de votos, desempate pela ordem de declaração, `position` começando em 1.

**D7. Encerramento.** Definitivo e idempotente: `closedAt` é gravado uma vez; `updatedAt === closedAt` ao encerrar; chamadas repetidas retornam o mesmo `closedAt`.

**D8. Erros como valores.** O domínio retorna `Result` com código de erro. Quem mapeia para HTTP é `infra`. Não use `throw` para fluxo de negócio.

---

## 5. Interpretações para pontos que a SPECS.md não fecha

O contrato HTTP/SSE (formatos, códigos de erro, campos do `ranking`, `closedAt` omitido enquanto aberta, `id:` igual a `version`) está definido na `SPECS.md`: **não o repita aqui nem o reinterprete**. Só estes pontos ficam decididos:

- **JSON malformado em rota com `:pollId`:** a ordem da seção 4.3 coloca `404` antes de `400`. Portanto, `POST /polls/:pollId/votes` com JSON malformado em enquete inexistente retorna `404 POLL_NOT_FOUND`, não `400`. Em enquete existente, retorna `400 INVALID_VOTE`. O erro de parsing não pode ser tratado por um middleware global antes de a rota verificar a enquete: capture-o e decida dentro do fluxo da rota (ou use parsing que adie o erro).
- **`durationSeconds`:** só inteiros de 1 a 86400 (ou `null`/omitido) são válidos. Strings, booleanos e decimais → `INVALID_POLL`.
- **Heartbeat:** o contador de 15 s reinicia a cada evento enviado na conexão (ver R9).
- **Snapshot e throttle:** o snapshot inicial não conta como "último evento" para o intervalo mínimo do throttle (ver R2).

## 6. Documentação da API (OpenAPI)

Gere e mantenha o arquivo `openapi.yaml` na raiz, no formato OpenAPI 3.0 ou 3.1. Não é necessário Swagger UI nem servir a documentação pela API: o arquivo estático basta.

O `openapi.yaml` deve conter:

- **Todas as rotas da `SPECS.md`:** `POST /polls`, `GET /polls/{pollId}`, `POST /polls/{pollId}/votes`, `GET /polls/{pollId}/stream`, `POST /polls/{pollId}/close` e `GET /health`.
- **Todos os status e códigos de erro** de cada rota (por exemplo, o voto tem `202`, `200`, `400`, `404`, `409`, `422`), cada um com seu schema. Os erros de `409` distinguem `POLL_CLOSED` de `USER_VOTE_LIMIT` (use `description` e `example`).
- **Schemas reutilizáveis em `components/schemas`:** `Poll`, `RankingEntry`, `Ranking`, `Vote`, `Error`. Referencie-os com `$ref`; não duplique definições.
- **Restrições de validação** nos schemas: `minLength`/`maxLength`, `minItems`/`maxItems`, `uniqueItems`, `minimum`/`maximum` (`durationSeconds` de 1 a 86400), `enum` para `status`.
- **O stream SSE** descrito com `text/event-stream` na resposta `200`: explique em `description` os eventos `ranking`, `closed` e o comentário de heartbeat, e o formato das linhas `id:`, `event:` e `data:`. O OpenAPI não modela SSE nativamente, então a descrição textual é o que importa.
- **`info` e `servers`** preenchidos (título, versão, `http://localhost:3000`).

### Regras

- A documentação descreve o **comportamento real**. Se mudar uma rota, um status ou um schema, atualize o `openapi.yaml` na mesma tarefa.
- `npm run lint:openapi` deve falhar se o arquivo for inválido ou se alguma rota registrada no Express não estiver documentada. Implemente essa checagem de cobertura num teste ou script simples, sem nova dependência de runtime. Uma devDependency para validar o OpenAPI é permitida.
- Não copie trechos longos da `SPECS.md`: descreva o contrato de forma concisa e deixe os detalhes de regra de negócio na spec.

## 7. Testes

- **Domínio:** testes unitários puros, sem timers e sem rede. Cubra a tabela de ordem de verificação (D2) com um caso por linha.
- **Aplicação:** marble tests com `TestScheduler` para throttle leading+trailing, flush do `closed`, encerramento automático e cancelamento do timer.
- **HTTP:** `supertest` + cliente SSE, servidor em porta efêmera (`listen(0)`), fechado no `afterAll`. Cubra: snapshot inicial, vários clientes com a mesma sequência, isolamento entre enquetes, desconexão de um cliente, rajada de votos paralelos (soma das contagens = número de `202`).
- **Escreva o teste antes da implementação** de cada regra de negócio e confirme que ele falha pelo motivo certo.
- `npm test` deve encerrar sozinho com código 0. Se travar, há timer ou servidor aberto: corrija a causa, não adicione `--forceExit`.

---

## 8. Proibido

- Desabilitar regras de lint (`eslint-disable`), `@ts-ignore`, `@ts-expect-error` ou `any` para fazer o `validate` passar.
- Alterar `eslint.config.*`, `.dependency-cruiser.cjs` ou `tsconfig.json` para afrouxar regras.
- Usar `--forceExit`, `process.exit()` ou `setTimeout` de espera nos testes.
- Persistência, banco, broker externo ou nova dependência de runtime sem pedir confirmação.
- Procurar arquivos fora deste diretório ou inferir suítes de teste externas: elas não fazem parte do trabalho. Implemente pela `SPECS.md`.

---

## 9. Fluxo de trabalho esperado

1. Leia `SPECS.md` e este arquivo.
2. Para cada funcionalidade: teste que falha → implementação mínima → atualizar `openapi.yaml` → `npm run validate`.
3. Se o `validate` falhar, corrija a **causa**. Leia a mensagem da regra violada; ela aponta para a seção deste documento.
4. Ao terminar, rode `npm run validate` e `npm start`, e confirme manualmente `GET /health`.

## 10. Quando parar e perguntar

Pare e pergunte, em vez de decidir sozinho, se:

- a spec e este arquivo se contradizem;
- uma regra do harness impede uma exigência da spec;
- for necessária uma dependência nova ou mudança de configuração do harness.
