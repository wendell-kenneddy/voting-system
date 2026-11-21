# Plano de implementação — Leaderboard de votação ao vivo

## 1. Objetivo, fontes e limites desta entrega

Este plano orienta outro agente na implementação completa da API descrita em [`../docs/SPECS.md`](../docs/SPECS.md), considerando também os requisitos adicionais da solicitação do usuário. A entrega atual é o plano; a aplicação e o `DECISIONS.md` serão produzidos na execução das etapas abaixo.

- Colocar código, configurações, testes, documentação e arquivos de dependências dentro de `without-harness/`. Executar os comandos npm nesse diretório.
- Usar TypeScript, Node.js 20+, Express e RxJS. Manter os dados de negócio exclusivamente em memória.
- Implementar todas as funcionalidades, sem regras de negócio simuladas, funcionalidades pendentes, stubs ou comentários `TODO`.
- Entregar instalação, inicialização e testes autônomos; finalizar a implementação com um `DECISIONS.md` de 5 a 8 tópicos curtos.
- Tratar o SPECS como fonte dos contratos da aplicação. As decisões deste plano resolvem detalhes internos sem ampliar esses contratos. Não incluir frontend, autenticação, persistência, broker, múltiplas instâncias, replay de SSE, reabertura ou remoção de enquetes encerradas.

## 2. Arquitetura e estrutura sugeridas

Separar a criação da aplicação de sua inicialização HTTP. Importar módulos em testes não pode abrir portas ou iniciar temporizadores globais.

```text
without-harness/
  package.json
  package-lock.json
  tsconfig.json
  tsconfig.test.json
  vitest.config.ts
  .gitignore
  README.md
  IMPLEMENTATION_PLAN.md
  DECISIONS.md                       # escrever ao concluir a implementação
  src/
    config.ts                       # leitura e validação de ambiente
    app.ts                          # factory Express e composição das dependências
    server.ts                       # listen, sinais e desligamento
    domain/
      types.ts                      # modelos e DTOs explícitos
      errors.ts                     # erros esperados e códigos HTTP
      validation.ts                 # validação dos corpos
      ranking.ts                    # projeção imutável do estado
    polls/
      poll-store.ts                 # Map e criação do estado por enquete
      poll-service.ts               # comandos e consultas síncronos
      poll-runtime.ts               # pipeline RxJS e encerramento automático
    http/
      poll-routes.ts
      error-handler.ts
      sse.ts                        # enquadramento e ciclo de vida de cada conexão
  test/
    helpers/
      app-fixture.ts                # servidor real em porta efêmera e teardown
      sse-client.ts                 # parser incremental e observação dos eventos
      builders.ts                   # dados e requisições válidas reutilizáveis
    config.test.ts
    validation.test.ts
    poll-service.test.ts
    poll-runtime.test.ts
    http.test.ts
    sse.test.ts
    concurrency.test.ts
    load.test.ts
    lifecycle.test.ts
```

Os nomes podem ser ajustados se a responsabilidade continuar explícita. Evitar uma camada genérica de repositório, um barramento global de votos ou abstrações de persistência sem uso. Cada instância de aplicação deve possuir seu próprio store e poder ser descartada integralmente.

### 2.1 Dependências e scripts

- Produção: `express` e `rxjs`.
- Desenvolvimento: `typescript`, `@types/node` compatível com Node 20, `@types/express` correspondente à versão de Express escolhida e `vitest` em versão compatível com o Node mínimo suportado. Confirmar essa compatibilidade antes de fixar as versões; não selecionar automaticamente uma versão que exija Node posterior ao 20.
- Usar `node:crypto.randomUUID()` para IDs, sem dependência adicional.
- Fixar a resolução no `package-lock.json` e versioná-lo. Não gravar votos, enquetes ou rankings nesse arquivo nem em outros arquivos de runtime.
- Configurar TypeScript com `strict`, `noUncheckedIndexedAccess`, `esModuleInterop` e alvo compatível com Node 20. Uma opção simples é CommonJS: `module: CommonJS`, `target: ES2022`, `rootDir: src`, `outDir: dist`, sem `type: module` no pacote.
- O `tsconfig.test.json` deve estender a base, incluir `src`, `test` e a configuração do runner, redefinir `rootDir` para `.` e usar `noEmit`, evitando excluir testes da checagem de tipos.
- Configurar Vitest para executar uma vez e finalizar, sem watch e sem `forceExit`. Manter a suíte temporal/carga sem disputa com outros arquivos, usando execução serial de arquivos. A paralelização de requisições dentro dos testes de concorrência deve continuar ativa.

Scripts esperados:

```json
{
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck:test": "tsc -p tsconfig.test.json",
    "start": "npm run build && node dist/server.js",
    "test": "npm run build && npm run typecheck:test && vitest run"
  }
}
```

O script `start` deve funcionar logo após `npm install`, sem exigir compilação manual anterior. O processo de `npm test` deve encerrar com `0` quando todos os testes passarem e com código diferente de zero quando houver falha; não mascarar falhas ou vazamentos de recursos.

## 3. Configuração e modelo em memória

### 3.1 Configuração

Construir `readConfig(env)` e passar sua saída à factory da aplicação. Não ler `process.env` repetidamente dentro das regras de negócio.

| Variável | Padrão | Validação escolhida |
|---|---:|---|
| `PORT` | 3000 | Inteiro entre 1 e 65535 na inicialização de produção |
| `MAX_VOTES_PER_USER` | 3 | Inteiro seguro, maior ou igual a zero |
| `RANKING_THROTTLE_MS` | 1000 | Inteiro seguro, maior ou igual a zero, dentro do intervalo suportado por temporizadores Node |

A ausência da variável usa o padrão. Um valor explicitamente informado e inválido, inclusive string vazia, deve causar falha de inicialização com mensagem clara. Não usar `parseInt` aceitando sufixos nem fallback com `||`. Aceitar e preservar `0` nas duas variáveis de negócio. A restrição a números inteiros e a política de falha para configurações inválidas são decisões internas, pois o SPECS não define seu tratamento.

Nos testes, injetar a configuração diretamente e chamar `listen(0, '127.0.0.1')` para obter porta efêmera. Isso não exige aceitar `PORT=0` na configuração de produção.

### 3.2 Estado por enquete

Manter `Map<string, PollState>`, com pelo menos:

```text
id, title, options: readonly string[]
optionIndexes: Map<string, number>
counts: number[]                  # mesma ordem de options
acceptedVoteIds: Set<string>
userVoteCounts: Map<string, number>
version: number                 # também é o total de votos aceitos
status: 'open' | 'closed'
createdAt, updatedAt: string
closesAt: string | null
closedAt: string | null
deadlineMs: number | null
runtime: recursos RxJS, agendamentos e canal de eventos da enquete
```

- A unicidade de `voteId` é local à enquete. Guardar o ID é suficiente: a especificação não exige histórico dos corpos de votos.
- Usar `Map` e `Set`, inclusive para identificadores como `__proto__`, sem dicionários com propriedades herdadas.
- O único contador de votos aceitos é `version`; projetar `totalVotes` com o mesmo valor. Manter as contagens por opção para montar o ranking.
- Preservar literalmente as strings recebidas. Usar `trim()` apenas no predicado que identifica strings inteiramente brancas, nunca para armazenar, comparar ou devolver dados normalizados.
- Na criação, `status=open`, `version=0`, todas as contagens são zero, `closedAt=null` e `updatedAt=createdAt`.
- Capturar o instante de criação uma vez; calcular `closesAt` a partir dele quando houver duração.
- Cada chamada de projeção retorna objetos e arrays novos. Não expor o estado mutável nem reutilizar snapshots que serão alterados depois.

### 3.3 Projeções e ordenação

Implementar uma projeção de ranking comum às rotas e aos eventos:

1. Criar uma entrada para cada opção, inclusive as de zero votos.
2. Ordenar por contagem decrescente e, em empate, pelo índice original crescente.
3. Atribuir `position` sequencial começando em 1, inclusive nos empates.
4. Preencher `pollId`, `status`, `version`, `totalVotes`, `ranking` e `updatedAt`.
5. Incluir `closedAt` apenas quando o estado estiver encerrado na projeção base.

DTOs de resposta:

- Criação: exatamente `{ id, title, options, status: 'open', closesAt }`.
- Consulta: ranking base acrescido de `title`, `closesAt` e `closedAt`; este último é `null` enquanto a enquete estiver aberta.
- SSE `ranking`: ranking base aberto, sem `closedAt`, `title` ou `closesAt`.
- Fechamento manual e SSE `closed`: ranking base encerrado, incluindo `closedAt`, sem os campos adicionais exclusivos da consulta.

A comparação entre GET, fechamento e SSE deve considerar os campos comuns: os metadados extras do GET não tornam os DTOs literalmente idênticos. Ao aceitar voto, atualizar `updatedAt`; rejeições e duplicatas não mudam timestamps. Ao fechar, usar uma única captura de horário para `closedAt` e `updatedAt`, sem incrementar `version`.

## 4. Comandos síncronos e invariantes

### 4.1 Criar enquete

Validar o corpo antes de alocar estado, Subject ou timer:

- Objeto JSON não nulo, que não seja array.
- `title`: string de 1 a 200 caracteres e não composta só por espaços em branco.
- `options`: array de 2 a 10 strings; cada string não branca, com até 100 caracteres; unicidade por igualdade exata.
- `durationSeconds`: ausente ou `null` significa fechamento manual; caso presente e diferente de `null`, exigir número inteiro de 1 a 86400. Não converter strings em números.
- Campos extras podem ser ignorados, pois o SPECS não os proíbe; usar a mesma política de forma consistente em votos.
- Usar `string.length` para os limites de tamanho e registrar essa convenção na documentação, pois a especificação não define outra unidade Unicode.

Criar o estado e seu runtime uma única vez. Se houver duração, agendar o encerramento automático. Devolver `201` somente com o DTO de criação.

### 4.2 Aceitar voto — ordem obrigatória

O fluxo completo de validação de estado e mutação deve executar sem `await`, Promises intermediárias ou callbacks que retomem a mutação depois:

```text
1. Buscar a enquete; se inexistente, 404 POLL_NOT_FOUND.
2. Validar corpo e campos; se inválidos, 400 INVALID_VOTE.
3. Verificar/aplicar encerramento vencido; se fechada, 409 POLL_CLOSED.
4. Verificar se option pertence exatamente às opções; se não, 422 UNKNOWN_OPTION.
5. Verificar acceptedVoteIds; se já contém voteId, 200 duplicate.
6. Verificar userVoteCounts contra o limite; se atingido, 409 USER_VOTE_LIMIT.
7. No mesmo trecho síncrono:
   registrar voteId;
   incrementar contador do usuário e da opção;
   incrementar version;
   atualizar updatedAt;
   solicitar publicação assíncrona compartilhada, sem executar fan-out agora.
8. Devolver 202 { status: 'accepted', voteId }.
```

Todos os campos do voto devem ser strings não brancas; `voteId` e `userId` têm no máximo 100 caracteres. Não impor limite independente de 100 caracteres a `option` no voto: após validar que é string não branca, uma string que não corresponde a uma opção resulta em `422`, conforme a ordem contratual.

Consequências a preservar:

- Uma repetição com corpo inválido continua sendo `400`.
- Uma repetição depois de fechada continua sendo `409 POLL_CLOSED`.
- Uma repetição com opção desconhecida continua sendo `422`.
- Uma repetição válida depois que o usuário atingiu o limite continua sendo `200 duplicate`.
- `MAX_VOTES_PER_USER=0` impede qualquer novo voto válido com `409 USER_VOTE_LIMIT`.
- IDs que diferem em espaços, capitalização ou representação Unicode permanecem diferentes.

O estado deve estar atualizado antes do envio do `202`. GET consulta diretamente esse estado e nunca aguarda o throttle.

### 4.3 Encerrar enquete

Implementar uma única operação síncrona de encerramento, usada pela rota, pelo timer e pela verificação de prazo:

1. Se já estiver fechada, retornar sua projeção final, sem nova emissão e sem alterar timestamps.
2. Capturar o timestamp de encerramento uma vez.
3. Definir `status=closed`, `closedAt=timestamp` e `updatedAt=timestamp`.
4. Cancelar o timer de duração, a publicação agendada e qualquer trailing pendente do throttle.
5. Projetar o estado atual completo, incluindo todos os votos já aceitos.
6. Publicar exatamente um evento `closed`, fora do throttle, pelo canal compartilhado.
7. Completar os canais e assinaturas da enquete e encerrar as conexões SSE associadas.
8. Preservar os dados finais no store para consultas futuras.

Cancelar primeiro a publicação pendente evita que a finalização de um operador descarregue um `ranking` após o fechamento. A projeção final deve vir dos contadores atuais, nunca do último snapshot publicado.

O timer deve fechar a enquete em até 500 ms do prazo. Como reforço, ao votar, consultar, conectar stream ou fechar manualmente, verificar sincronamente `deadlineMs` e encerrar se já venceu; isso impede aceitação tardia caso o callback do timer ainda não tenha rodado. No voto, preservar a precedência de corpo inválido antes de estado fechado. Se o timer atrasar, `closedAt` registra o instante efetivo de encerramento; `closesAt` permanece o prazo planejado.

Na concorrência entre voto e fechamento, a ordem de execução síncrona no event loop decide: ou o voto é totalmente aceito antes da transição e aparece no resultado final, ou encontra a enquete fechada e é rejeitado. Não há fase assíncrona de contagem a drenar.

## 5. RxJS, throttling e distribuição

### 5.1 Um runtime compartilhado por enquete

Criar um Subject de notificações de mudança e um único pipeline de publicação por enquete, iniciado na criação e encerrado no fechamento. Conexões SSE assinam somente o canal de saída compartilhado. Não criar `throttleTime` por conexão nem conectar o processamento de votos ao número de assinantes SSE.

Fluxo recomendado:

```text
comando síncrono de voto
  -> estado atualizado
  -> marca publicação necessária e agenda uma única ação por enquete
  -> responde 202

ação agendada fora da pilha do comando
  -> notifica changes$
  -> throttleTime(intervalo, scheduler, { leading: true, trailing: true })
  -> projeta o estado mais recente
  -> ignora version já publicada, se houver
  -> events$ compartilhado
  -> adaptadores SSE
```

- A notificação pode carregar apenas um sinal; projetar depois do throttle assegura que a borda final veja todos os votos.
- Usar uma ação RxJS agendada e coalescida por enquete. Enquanto uma ação estiver pendente, novos votos apenas marcam a mudança, sem enfileirar uma ação para cada cliente ou voto.
- Limpar a referência da ação no início da execução, para que votos posteriores possam agendar nova publicação.
- Manter uma assinatura interna única no pipeline e um Subject de saída quente; não depender de `refCount` para recriar o throttle quando clientes conectarem ou saírem.
- A primeira mudança sem janela ativa deve publicar imediatamente no próximo turno do scheduler, dentro do limite de 300 ms.
- Durante a janela, agrupar alterações e publicar a versão mais recente na borda final. Uma emissão trailing também estabelece a cadência para a próxima emissão.
- Sem alteração não emitir `ranking`; não usar `interval` para consultar o estado periodicamente.
- Com intervalo zero, não impor espera artificial; coalescer mudanças do mesmo turno é aceitável, desde que a última versão seja publicada sem perda de contagem.
- O snapshot inicial pertence à conexão e não entra no pipeline de mudanças nem inicia, reinicia ou consome a janela global.
- Conectar um cliente não deve publicar seu snapshot para clientes existentes. Não reemitir para ele um snapshot global antigo armazenado em `ReplaySubject`.
- Criar snapshots imutáveis evita regressão ou alteração retroativa de eventos já observados. Uma atualização global pendente pode coincidir com a versão do snapshot de uma conexão recente; ela nunca pode conter estado mais antigo.

RN-05 exige que o processamento do voto não cresça com a quantidade de clientes. A mutação e o pedido de publicação devem ter custo independente dessa quantidade. A escrita de um evento em N conexões inevitavelmente custa O(N), mas ocorre na fase de distribuição compartilhada, fora da pilha de processamento do voto. Não afirmar que todo o sistema terá custo independente de N: a rede e o event loop continuam compartilhados.

### 5.2 Erros e descarte

- Rejeições esperadas são resultados ou erros de domínio tratados pelo HTTP. Nunca chamar `.error()` no Subject de uma enquete por uma requisição inválida.
- Isolar falhas de escrita por conexão, para que uma resposta destruída não interrompa o fan-out para as demais.
- Cancelar ações do scheduler, assinatura do pipeline e timer automático ao encerrar. Não permitir flush de trailing após `closed`.
- Ao descartar a aplicação, terminar todos os runtimes, inclusive os de enquetes abertas, e limpar o store apenas depois de encerrar seu uso. Não remover enquetes fechadas enquanto a aplicação continuar em operação.

## 6. Adaptador HTTP e SSE

### 6.1 Rotas JSON e precedência de erros

| Rota | Sucesso | Erros contratuais |
|---|---|---|
| `POST /polls` | `201` + DTO de criação | `400 INVALID_POLL` |
| `GET /polls/:pollId` | `200` + ranking e metadados | `404 POLL_NOT_FOUND` |
| `POST /polls/:pollId/votes` | `202 accepted` ou `200 duplicate` | `404`, `400 INVALID_VOTE`, `409 POLL_CLOSED`, `422 UNKNOWN_OPTION`, `409 USER_VOTE_LIMIT`, nessa precedência |
| `GET /polls/:pollId/stream` | `200` + SSE | `404 POLL_NOT_FOUND` em JSON |
| `POST /polls/:pollId/close` | `200` + ranking final | `404 POLL_NOT_FOUND` |
| `GET /health` | `200 { "status": "ok" }` | — |

Toda falha contratual tem corpo `{ "error": "CODIGO", "message": "texto livre" }` e tipo JSON. As mensagens precisam ser úteis, mas os testes não devem fixar texto livre sem necessidade.

Detalhe essencial: **não instalar `express.json()` globalmente antes da busca da enquete na rota de votos**. Isso faria JSON malformado ganhar `400` antes do `404` obrigatório.

Organização sugerida:

- `POST /polls`: parser JSON local → validador/criação.
- `POST /polls/:pollId/votes`: lookup da enquete → parser JSON local → validação e comando síncrono.
- As demais rotas não precisam de parser de corpo; fechamento não tem corpo de negócio.
- Configurar o parser com `strict: false` para permitir que valores JSON primitivos cheguem ao validador, que os rejeita como corpo inválido. Capturar erros de sintaxe e responder com o código próprio da rota.
- Corpo ausente ou não interpretado como JSON deve cair na validação como inválido nas rotas que exigem corpo. Não retornar HTML de erro do Express.
- Mapear falhas de parsing e de tamanho do corpo, quando houver limite do parser, ao envelope de erro da rota. Escolher limite que aceite todos os corpos válidos definidos pelo SPECS.
- Instalar um tratador final de erros com envelope JSON; falhas inesperadas podem usar `500 INTERNAL_ERROR`, sem stack no corpo. Este código é uma decisão defensiva para situações fora dos erros contratuais; os testes de carga não podem produzir `5xx`.
- Não tentar enviar JSON depois de iniciar uma resposta SSE; nesse caso, liberar a conexão afetada.

### 6.2 Abertura de SSE

1. Buscar a enquete antes de enviar headers; retornar `404` JSON se ausente.
2. Aplicar a verificação de prazo vencido.
3. Configurar `Content-Type: text/event-stream`, `Cache-Control: no-cache` e conexão persistente; enviar os headers com `flushHeaders()`.
4. Se já estiver fechada, escrever somente `closed` e encerrar imediatamente, sem assinatura ou heartbeat permanentes.
5. Se aberta, registrar a assinatura de saída, escrever imediatamente o snapshot atual como `ranking` e iniciar o controle de heartbeat.

Fazer a instalação da assinatura e o envio do snapshot no mesmo trecho síncrono, sem `await`, para não abrir uma lacuna entre snapshot e atualizações. A inscrição em um Subject simples não deve produzir evento histórico síncrono.

Construir cada frame em UTF-8 como `id: ${version}\nevent: ${event}\ndata: ${JSON.stringify(snapshot)}\n\n`. Exemplo visual (a linha em branco final faz parte do frame):

```text
id: <version>
event: ranking
data: <JSON em uma linha>

```

Usar o mesmo formato com `event: closed` no encerramento. `id` é a representação decimal de `version`; o evento final pode ter o mesmo ID do último ranking, porque fechar não aceita voto novo. Não usar ID de enquete no campo SSE `id`.

### 6.3 Heartbeat e desconexão

- Cada conexão mantém um único temporizador de inatividade de 15 segundos.
- Após cada frame enviado, reiniciar a espera de inatividade; em silêncio, escrever exatamente `: heartbeat\n\n` e rearmar a espera.
- Heartbeat não muda versão, contagem, timestamp de negócio ou janela de throttling. Não tem `id`, `event` ou `data`.
- Implementar `cleanup()` idempotente que cancele o timer, desassine o canal da enquete, retire listeners e remova a conexão do registro ativo.
- Usar o fechamento da resposta/socket e erros de escrita para detectar desconexão; não interpretar o simples término do recebimento da requisição GET como desconexão do stream.
- Ao receber `closed`, cancelar heartbeat, enviar o frame final uma vez, chamar `res.end()` e executar cleanup. Usar uma flag por conexão para impedir escrita ou encerramento duplicado.
- Não guardar histórico nem filas próprias ilimitadas de frames por cliente. Não deixar callbacks ou referências da resposta após cleanup.

### 6.4 Encerramento da aplicação

A factory deve retornar, por exemplo, `{ app, dispose }`; o bootstrap mantém o `http.Server`. Em `SIGINT` e `SIGTERM`, parar novas conexões, finalizar streams/runtimes, aguardar o fechamento HTTP e liberar os recursos. Tornar o desligamento idempotente e evitar `process.exit()` antes de concluir a limpeza.

Tratar keep-alive e conexões remanescentes no shutdown com as APIs do servidor e um prazo finito; cancelar o próprio timer de prazo quando o fechamento terminar. `unref()` pode ser usado quando apropriado, mas não substitui cancelar timers e assinaturas. Testes devem comprovar encerramento real sem depender de saída forçada.

## 7. Estratégia de testes

Usar as regras de negócio reais em todas as camadas. Relógio e scheduler controláveis são instrumentos de teste, não substitutos das regras. Separar testes determinísticos de tempo dos testes HTTP com relógio real; não misturar fake timers com leitura de sockets reais.

### 7.1 Infraestrutura autônoma

- `createFixture(config)` instancia a aplicação e inicia o servidor em loopback e porta efêmera; retorna URL, dependências observáveis para testes e teardown assíncrono.
- Cada teste recebe estado novo. Restaurar ambiente, spies e temporizadores falsos ao terminar.
- Toda espera por evento deve ter timeout e limpeza. Evitar polling sem limite e sleeps arbitrários para esperar uma condição que pode ser observada diretamente.
- O cliente SSE de teste deve interpretar chunks parciais, múltiplos frames no mesmo chunk, comentários e o EOF. Não presumir que um `data` corresponde a um chunk TCP.
- Usar `AbortController` ou sockets com destruição explícita para consumidores SSE; registrar todos os recursos na fixture.
- O teardown em `finally`/hooks deve cancelar leitores, fechar conexões, chamar `dispose()` e aguardar `server.close()`, inclusive quando uma asserção falhar.
- Para contratos HTTP, fazer chamadas reais à aplicação; para invariantes de scheduling e contagem de recursos, usar testes de unidade com scheduler/relógio controlado.
- Não iniciar um processo de produção externo como pré-condição da suíte.

### 7.2 Configuração e validação

Cobrir os padrões, valores customizados, zeros válidos e configuração inválida. Testar limites e casos representativos por tabela:

- Título ausente, tipos errados, vazio, apenas espaços/tabs/quebras de linha, tamanhos 1, 200 e 201.
- Quantidade de opções 1, 2, 10 e 11; elemento não string, branco, tamanho 100 e 101; duplicatas exatas.
- Opções `A`, `a` e ` A ` distintas; armazenamento e retorno preservando espaços e capitalização.
- Duração ausente, `null`, 1, 86400, 0, 86401, fracionária, string e booleana.
- Votos com campos ausentes, tipos errados, brancos e limites 100/101 para `voteId` e `userId`.
- `option` não branca desconhecida, inclusive acima de 100 caracteres, retorna `422`; branca retorna `400`.
- Corpos array, string, número, booleano, `null`, vazios e JSON malformado nas duas rotas de escrita.
- Identificadores opacos, incluindo `__proto__`, diferenças de caixa e espaços, funcionam por igualdade exata.
- Campos extras seguem a política escolhida sem alterar os campos de negócio.

### 7.3 Contratos HTTP e precedência

Validar status, `Content-Type`, campos obrigatórios e envelope de todos os resultados da tabela de rotas. Incluir:

- Criação com e sem duração; GET inicial com todas as opções zeradas, ordem declarada, `version=totalVotes=0`, `closedAt=null`, data ISO válida.
- GET após cada voto aceito dentro de uma janela de throttle longa já contém todos os votos; comparar `updatedAt` com o estado correspondente.
- Ranking com empate e desempate após vários votos; posições sequenciais, sem omitir opções zeradas.
- Enquete inexistente com corpo válido, inválido e JSON malformado: todos os votos retornam `404`.
- Enquete fechada com corpo inválido: `400`; fechada com opção desconhecida mas corpo válido: `409 POLL_CLOSED`.
- Duplicata com opção desconhecida: `422`; duplicata válida no limite: `200`; duplicata depois de fechar: `409`.
- Duplicata com outro usuário e opção válida não altera o voto original, os limites, `version`, `updatedAt` ou as emissões.
- Fechamento repetido devolve o mesmo ranking final e timestamps.
- `GET /health` retorna somente o contrato esperado.
- Erros não retornam HTML e preservam o formato padrão.

### 7.4 Matriz de rastreabilidade das regras

| Regra | Cenário e evidência de aceitação |
|---|---|
| RN-01 | Repetir `(pollId, voteId)` sequencialmente e em paralelo; uma única aceitação, sem nova contagem/evento/consumo de limite. Mesmo `voteId` aceito em outra enquete. |
| RN-02 | Aceitar exatamente o limite por usuário/enquete, rejeitar o seguinte; outro usuário e outra enquete continuam independentes. Cobrir limite zero. |
| RN-03 | Votos e fechamento em A não alteram estado, eventos ou janela de B; usar enquetes com ações intercaladas. |
| RN-04 | Com scheduler controlado: leading, coalescência, trailing com última versão, novo período após trailing, silêncio sem mudança e intervalo zero. Com SSE real: medir intervalo mínimo com tolerância de 100 ms e emissão fora da janela em até 300 ms. |
| RN-05 | Dois ou mais clientes ativos antes dos votos recebem a mesma sequência de eventos globais e os mesmos payloads. Uma conexão nova recebe seu snapshot próprio e as próximas atualizações, sem reemissão do snapshot aos demais. Verificar um pipeline por enquete e nenhuma escrita SSE síncrona na pilha de aceitação do voto. |
| RN-06 | Rajadas paralelas de votos únicos, duplicados e do mesmo usuário: soma do ranking = quantidade de `202`; `version=totalVotes`; limite nunca excedido. GET imediatamente após respostas aceitações confirma estado. |
| RN-07 | Com stream aberto, enviar corpo inválido, JSON malformado, opção desconhecida, duplicata e limite excedido; em seguida aceitar voto válido e observar nova atualização no mesmo stream. Exercitar também o tratador de falha inesperada sem envenenar o canal de eventos. |
| RN-08 | Desconectar cliente A, observar cancelamento de timer/assinatura e continuar votando com cliente B recebendo eventos. Repetir ciclos de conexão/desconexão. |
| RN-09 | Fechar manual e automaticamente; repetir fechamento; disputar votos/fechamento em paralelo; todo `202` aparece no final e toda operação de voto processada após fechar retorna `409`. Prazo automático respeita 500 ms. |
| RN-10 | Com throttle longo e votos pendentes, fechar e receber exatamente um `closed` com o estado mais recente em até 500 ms, seguido de EOF em até 500 ms. Nenhum ranking posterior; conexão tardia recebe apenas `closed`. |
| RN-11 | Fechar manualmente antes do prazo automático, avançar relógio e não observar outro fechamento. Cancelar trailing, timer automático e recursos SSE. GET e stream da enquete fechada continuam funcionando. |

Para RN-05, o teste estrutural pode observar o adaptador de saída ou a fronteira de agendamento sem substituir o serviço. O custo inevitável de fan-out não deve ser confundido com o custo da mutação do voto. Para a falha inesperada da RN-07, usar injeção de falha ou spy restrito ao teste e restaurado ao final; não introduzir endpoint de depuração ou regra de negócio simulada em produção.

### 7.5 Casos temporais obrigatórios de SSE

1. Snapshot de enquete aberta sem votos chega em até 500 ms e contém todas as opções.
2. Primeira atualização após silêncio chega em até 300 ms.
3. Votos durante a janela não geram emissões intermediárias indevidas; trailing entrega a última versão mesmo que não haja votos posteriores.
4. Conexão nova durante a janela recebe imediatamente o estado atual, sem reiniciar a janela dos clientes existentes.
5. Heartbeat aparece após 15 segundos de inatividade; atividade reinicia a espera; heartbeat não modifica a cadência global.
6. Nenhum `ranking` é emitido apenas porque transcorreu tempo, após voto duplicado ou após rejeição.
7. Fechar sem votos também envia `closed`, preservando `version=0` e as opções zeradas.
8. Fechar com trailing pendente ignora a espera e inclui os votos ainda não publicados.
9. Fechar automaticamente entrega evento e EOF dentro dos limites e não mantém timer vivo.
10. Cliente tardio de enquete fechada recebe só `closed`, nunca um `ranking` inicial.

Cobrir heartbeat e fronteiras com tempo virtual; manter ao menos um teste HTTP real de heartbeat com timeout superior a 15 segundos para verificar a integração. Medir latências reais com relógio monotônico (`performance.now()`), sem comparar apenas timestamps ISO. Nos testes de snapshot, contar desde o início da requisição; no fechamento manual, desde o disparo da requisição de fechamento; no automático, a partir do prazo previsto.

O runtime pode receber um scheduler e uma função `now` para testes, mas a configuração padrão deve usar relógio real. Testes virtuais não substituem as verificações de integração das tolerâncias reais.

### 7.6 Concorrência e carga

Executar teste automatizado de carga com:

1. Cinco enquetes abertas e streams observados, pelo menos um por enquete.
2. Mil votos únicos distribuídos entre elas ao longo de aproximadamente dois segundos; por exemplo, vinte lotes de cinquenta votos, agendados a cada 100 ms. Dentro de cada lote, enviar em paralelo.
3. Usuários únicos ou uma configuração que permita todos os votos da carga; não confundir rejeição legítima de limite com perda de votos.
4. Contar respostas por status: esperar mil `202`, nenhum erro de rede e nenhum `5xx`.
5. Consultar as cinco enquetes e verificar a soma global de mil votos; em cada enquete, soma do ranking = `version` = `totalVotes` = número local de respostas `202`.
6. Esperar a publicação trailing quando aplicável e verificar convergência dos streams para as últimas versões, sem contaminação entre enquetes.
7. Fechar as enquetes, consultar novamente e validar que os campos comuns dos eventos finais, respostas de fechamento e GETs coincidem, incluindo status e timestamps.

Além da carga, fazer testes concorrentes específicos de múltiplas requisições com o mesmo `voteId`, usuário perto do limite e votos simultâneos ao fechamento. Não depender de uma ordem particular de chegada das requisições; comparar respostas aceitas com o estado final. Em corrida com fechamento, um `202` pode chegar pela rede depois da resposta de fechamento e ainda ser legítimo, desde que a mutação tenha ocorrido antes e conste no resultado final.

### 7.7 Memória e recursos

- Observar registros internos de conexões, assinaturas e timers por testes de unidade/fixture; não criar endpoint público de diagnóstico.
- Repetir conexão/desconexão e verificar retorno ao número inicial de recursos por enquete.
- Após fechar, recursos transitórios da enquete devem chegar a zero, mantendo seus dados consultáveis.
- Destruir a aplicação com enquetes abertas, timers automáticos futuros e clientes ativos; o teardown deve terminar e o runner deve sair naturalmente.
- Não usar limiar frágil de heap ou coleta de lixo como único critério de vazamento. Demonstrar que as referências e agendamentos de propriedade da aplicação foram removidos.
- Separar retenção intencional de dados de negócio e vazamento: enquetes encerradas e dados necessários aos seus resultados continuam em memória, conforme o escopo; conexões, listeners e temporizadores não.

## 8. Sequência de execução para o agente implementador

### Etapa 1 — Base executável

Criar o pacote, configurações TypeScript, runner, `.gitignore` para `node_modules/`, `dist/` e arquivos temporários, factory da aplicação, bootstrap e health check. Instalar dependências e gerar lockfile. Implementar leitura de configuração e descarte básico.

**Saída verificável:** `npm install`, compilação, teste de configuração/health e inicialização na porta configurada funcionando; importar `app.ts` não abre servidor.

### Etapa 2 — Domínio e estado

Implementar tipos, validações, store, criação, ranking, aceitação síncrona de votos e fechamento idempotente. Nesta etapa, testar diretamente o serviço, incluindo strings, escopo dos IDs, limite zero, ordenação e invariantes. Conectar as notificações ao runtime real na etapa seguinte, sem deixar substitutos na entrega final.

**Saída verificável:** testes unitários do domínio passam; nenhuma mutação relevante contém `await`; toda aceitação já está refletida na consulta do serviço.

### Etapa 3 — Runtime RxJS

Construir o agendamento coalescido, pipeline compartilhado leading/trailing, canal final de eventos, timer de duração e descarte. Integrar o serviço ao runtime. Testar com scheduler controlado, incluindo cancelamento de trailing e ausência de fan-out na pilha do voto.

**Saída verificável:** RN-01 a RN-06 no nível de serviço/runtime e encerramento com votos pendentes cobertos deterministicamente.

### Etapa 4 — API JSON

Implementar as rotas de criação, consulta, voto, fechamento e health. Configurar parsers locais e middleware de erros. Validar toda a precedência com HTTP real, especialmente `404` antes de JSON inválido na rota de votos.

**Saída verificável:** contratos JSON e combinações de precedência passam, sem resposta HTML em erros de parsing.

### Etapa 5 — SSE e ciclo de vida

Implementar frames, snapshot inicial, assinatura compartilhada, heartbeat, conexão tardia fechada, cleanup por desconexão e fechamento final. Completar o shutdown da aplicação e do servidor.

**Saída verificável:** múltiplos clientes, RN-07 a RN-11, heartbeat, limites de latência e liberação de recursos cobertos por testes apropriados.

### Etapa 6 — Concorrência e requisitos não funcionais

Executar e ajustar os testes de corridas, isolamento, carga de mil votos e cadência real. Corrigir a implementação diante de falhas; não ampliar as tolerâncias do SPECS para fazer testes passarem.

**Saída verificável:** carga sem perdas/`5xx`, estado consistente, eventos convergentes e processo de teste terminando sem handles da aplicação abertos.

### Etapa 7 — Documentação e entrega

Escrever README enxuto com pré-requisitos, comandos a partir de `without-harness/`, configuração e zeros válidos, exemplos das rotas, consumo SSE e aviso de estado volátil/instância única. Registrar o tratamento escolhido para configuração inválida, campos extras e comprimento de strings.

Criar `DECISIONS.md` somente após confirmar as escolhas implementadas. Usar 5 a 8 tópicos curtos, por exemplo:

1. Factory da aplicação separada do servidor e descarte explícito.
2. `Map`/`Set` por enquete e ausência de persistência.
3. Comandos síncronos, contador único de versão e projeções imutáveis.
4. RxJS compartilhado por enquete, leading/trailing e agendamento fora da mutação.
5. Encerramento único, imediato e independente do throttle.
6. Parsing por rota e precedência dos erros.
7. Testes com porta efêmera, tempo controlado e integração/carga reais.

Não apresentar decisões planejadas como escolhas concluídas se a implementação final mudou.

## 9. Checklist de aceite final

- [x] Todos os arquivos produzidos estão em `without-harness/`; `docs/SPECS.md` permanece como referência.
- [x] `npm install` funciona em ambiente limpo com uma versão compatível do Node 20+.
- [x] `npm start` compila e inicia o HTTP em `PORT`, ou 3000 por padrão; validar também uma porta personalizada.
- [x] As duas variáveis de negócio respeitam `0` e configuração customizada.
- [x] `npm test` compila, verifica tipos e executa a suíte completa sem servidor externo, watch ou saída forçada.
- [x] Todos os status, DTOs e envelopes de erro das seis rotas estão cobertos.
- [x] Há evidência de teste para cada RN-01 a RN-11 e cada requisito não funcional.
- [x] GET reflete imediatamente cada voto aceito; a soma das opções e `version` coincidem com `totalVotes`.
- [x] SSE tem snapshot, leading/trailing, heartbeat, isolamento e distribuição compartilhada corretos.
- [x] Fechamento inclui mudanças pendentes, mantém timestamps e encerra streams/timers nos limites previstos.
- [x] A carga de mil votos em cinco enquetes não perde votos nem produz `5xx`.
- [x] A suíte termina naturalmente com código `0` em sucesso, fechando recursos mesmo em caminhos de falha.
- [x] Não há armazenamento externo, funcionalidades pendentes, stubs de negócio ou comentários `TODO` no código entregue.
- [x] README e `DECISIONS.md` correspondem à implementação final; o registro contém de 5 a 8 tópicos curtos.

Executar os checks finais a partir do diretório do projeto. Fazer também um smoke test do processo iniciado por `npm start`, verificando `/health`, uma criação/consulta e encerramento limpo do processo. Registrar no resumo da implementação os comandos executados e seus resultados reais; não declarar como executado um teste apenas previsto neste plano.

## 10. Registro da execução — 21/11/2026

Etapas 1 a 7 concluídas. Código, testes, lockfile e documentação foram entregues neste diretório; a especificação original foi preservada.

- Ambiente validado: Node.js 20.20.2 e npm 10.8.2. Como Node/npm não estavam no PATH do shell, foi usado o binário oficial em `/tmp/voting-toolchain/node-v20.20.2-linux-x64/bin`, com checksum verificado.
- `npm install`, com `node_modules` ausente: sucesso; 121 pacotes instalados e auditoria com zero vulnerabilidades. Vitest 4.1.12 e Vite 6.4.6 foram escolhidos após consultar a compatibilidade declarada com Node 20.
- `npm test`: build e checagem de tipos de produção/testes concluídos; 123 testes em 9 arquivos passaram, com saída natural `0`. Inclui heartbeat HTTP real, prazos de SSE, concorrência e mil respostas `202` em cinco enquetes, sem perdas ou `5xx`.
- `npm start`: smoke test real na porta padrão 3000 e em porta personalizada, com health, criação, consulta, voto, snapshot SSE e EOF. SIGTERM e SIGINT encerraram os processos com código `0`, inclusive com streams ativos e fechamento automático futuro.
- `MAX_VOTES_PER_USER=0` e `RANKING_THROTTLE_MS=0` também foram usados no processo de smoke test. Uma configuração explicitamente vazia foi rejeitada com mensagem clara e saída `1`.
- A revisão de shutdown adicionou proteção e regressão para corpos ainda em leitura: comandos retomados depois do descarte recebem `503 SERVICE_UNAVAILABLE` e não recriam timers ou enquetes.
- `git diff --check` sem erros; código sem `TODO`, `FIXME`, `forceExit` ou chamadas de `process.exit()`.

O mapa dos testes por regra está no README; o registro final de decisões contém sete tópicos em `DECISIONS.md`.
