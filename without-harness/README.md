# API de votação ao vivo

Implementação de [SPECS.md](../docs/SPECS.md) em TypeScript, Express e RxJS. Requer Node.js 20+ e npm. Todos os comandos abaixo partem de `without-harness/`:

```bash
npm install
npm start
```

`npm start` compila e inicia a API; não exige build anterior. `npm test` compila, verifica também os tipos dos testes e executa a suíte sem servidor externo, sem watch e sem saída forçada. A suíte dura cerca de 24 segundos, incluindo uma espera real de 15 segundos pelo heartbeat. `npm run build` e `npm run typecheck:test` estão disponíveis separadamente.

| Variável | Padrão | Valores aceitos |
| --- | --- | --- |
| `PORT` | `3000` | Inteiro de 1 a 65535 |
| `MAX_VOTES_PER_USER` | `3` | Inteiro seguro ≥ 0; zero impede novos votos |
| `RANKING_THROTTLE_MS` | `1000` | Inteiro de 0 a 2147483647; zero remove a espera |

Variáveis ausentes usam os padrões. Valores explicitamente inválidos, inclusive vazios, encerram a inicialização com mensagem de erro. Os valores devem ser sequências de dígitos, sem sufixos, espaços ou notação exponencial.

```bash
PORT=4000 MAX_VOTES_PER_USER=5 RANKING_THROTTLE_MS=250 npm start
```

Crie uma enquete e substitua `POLL_ID` nos comandos seguintes pelo `id` retornado:

```bash
curl -i http://localhost:3000/health

curl -i -X POST http://localhost:3000/polls \
  -H 'Content-Type: application/json' \
  -d '{"title":"Linguagem favorita?","options":["TypeScript","Go","Rust"],"durationSeconds":60}'

curl -N http://localhost:3000/polls/POLL_ID/stream

curl -i -X POST http://localhost:3000/polls/POLL_ID/votes \
  -H 'Content-Type: application/json' \
  -d '{"voteId":"v1","userId":"u1","option":"TypeScript"}'

curl -i http://localhost:3000/polls/POLL_ID
curl -i -X POST http://localhost:3000/polls/POLL_ID/close
```

`durationSeconds` aceita inteiros de 1 a 86400; omissão ou `null` permite apenas fechamento manual. A criação retorna `201`; um novo voto retorna `202`, e uma duplicata válida retorna `200`. Consultas e fechamento retornam `200`. Erros usam JSON `{ "error": "CODIGO", "message": "..." }`. A ordem de validação de votos é: existência, corpo, estado aberto, opção, duplicidade, limite por usuário.

Cada conexão SSE recebe o snapshot atual imediatamente, seguido de atualizações `ranking` compartilhadas por enquete com leading/trailing. O `id` do frame é a versão, igual ao total de votos aceitos. Após 15 segundos de inatividade, o comentário exato `: heartbeat\n\n` mantém a conexão. O fechamento envia um único `closed` com todos os votos aceitos, ignora o throttle e termina o stream. Uma conexão tardia recebe apenas `closed`. Clientes que excedem a capacidade de escrita do socket são desconectados para limitar a retenção de memória.

O GET consulta os contadores atuais, mesmo com publicação SSE pendente. Empates respeitam a ordem original das opções; todas as opções aparecem. Fechamento é definitivo e idempotente; `closedAt` e `updatedAt` coincidem. SIGINT e SIGTERM param novas conexões, encerram streams e cancelam recursos; conexões HTTP remanescentes têm prazo de dois segundos.

Durante o desligamento, comandos que ainda aguardavam o corpo retornam `503 SERVICE_UNAVAILABLE`, impedindo criar recursos após o descarte.

Strings são preservadas literalmente, sem normalização. `trim()` serve apenas para rejeitar campos inteiramente brancos. Os limites usam `string.length` (unidades UTF-16). Campos extras são ignorados. O parser aceita até 1 MiB de JSON e responde com o código de corpo inválido da rota quando esse limite é excedido.

O estado é volátil e pertence a uma única instância: reiniciar perde todos os dados. Enquetes encerradas permanecem consultáveis até o desligamento. Não há autenticação, persistência, frontend ou replay de SSE; `userId` é um identificador informado pelo cliente e qualquer cliente pode encerrar uma enquete.

O código separa comandos síncronos e projeções em `src/domain/` e `src/polls/`, distribuição RxJS em `poll-runtime.ts` e transporte em `src/http/`. A factory `createApp(config)` não abre portas e retorna `dispose()`. Não há temporizadores globais na importação.

| Evidência automatizada | Arquivos em `test/` |
| --- | --- |
| Configuração, limites e strings | `config.test.ts`, `validation.test.ts` |
| RN-01, RN-02, RN-03, RN-06: contagem, idempotência, limites, isolamento | `poll-service.test.ts`, `http.test.ts`, `concurrency.test.ts` |
| RN-04, RN-05: coalescência, leading/trailing e distribuição fora do voto | `poll-runtime.test.ts`, `sse.test.ts`, `lifecycle.test.ts` |
| RN-07, RN-08: erros, desconexão e liberação de conexões | `http.test.ts`, `sse.test.ts`, `lifecycle.test.ts` |
| RN-09, RN-10, RN-11: prazos, resultado final, cancelamento e shutdown | `poll-runtime.test.ts`, `sse.test.ts`, `lifecycle.test.ts`, `concurrency.test.ts` |
| Mil votos em cinco enquetes em aproximadamente dois segundos | `load.test.ts` |

Testes de tempo virtual comprovam fronteiras e cancelamento; HTTP real verifica os contratos, heartbeat, latência inicial/leading/final, EOF e cadência. Recursos internos são inspecionados diretamente, sem endpoints de diagnóstico.
