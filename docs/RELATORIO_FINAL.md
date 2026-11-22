# Relatório final de comparação das implementações de votação reativa

**Data da avaliação:** 21 de novembro de 2026.  
**Versões avaliadas:** `com-harness/` e `without-harness/`, no estado de código do commit `8461715`.

As duas implementações entregam uma API de votação em memória com Express, TypeScript, RxJS e atualização por Server-Sent Events. O harness produziu uma separação mais rigorosa das camadas e um conjunto mais completo de verificações estáticas. A implementação sem harness apresentou testes mais abrangentes de operação e um tratamento mais robusto de desligamento e clientes SSE lentos.

**O resultado não sustenta uma vitória geral de uma abordagem.** Ambas passam nas próprias suítes, mas a revisão encontrou uma não conformidade com a RN-05 e uma falha de ciclo de vida na versão com harness. Na versão sem harness, encontrou dois desvios de separação arquitetural, segundo os critérios comuns explicitados abaixo. A quantidade histórica de erros e de intervenções humanas não foi registrada de forma que permita uma comparação numérica confiável.

## Escopo e método de avaliação

A referência funcional é [SPECS.md](SPECS.md). A análise confrontou código, testes, configurações, planos e decisões. O conteúdo dos slides não foi verificado nesta avaliação.

Foram realizadas leitura estática, execução das validações existentes e duas reproduções adicionais sobre o código compilado. Essas reproduções estão em [diagnostico.cjs](diagnostico.cjs), com resultados em [diagnostico.json](diagnostico.json). Nenhuma correção foi aplicada às implementações durante a avaliação.

Para evitar contagens enganosas, foram separados quatro conceitos:

- **Falha de teste existente:** caso que falha na suíte entregue.
- **Não conformidade funcional:** comportamento observado que contraria um requisito da SPECS.
- **Desvio arquitetural:** quebra de um critério explícito de separação de responsabilidades; não equivale automaticamente a erro funcional.
- **Problema de robustez:** comportamento operacional indesejado em situação que a SPECS não detalha integralmente.

Cada problema foi contado uma vez por causa identificada. Falta de ferramenta, ausência de um teste e defeito de implementação não foram somados como se fossem o mesmo tipo de erro.

## Resultados executados

Ambiente desta avaliação: **Node.js 22.22.1, npm 9.2.0 e Vitest 4.1.12**. Os testes HTTP usam servidores locais em portas efêmeras. A restrição inicial do ambiente provocou `listen EPERM`; a execução foi repetida com permissão de abertura de portas locais. Essa ocorrência ambiental não entra na contagem de defeitos dos projetos.

| Verificação | Com harness | Sem harness |
| --- | --- | --- |
| Compilação de produção | `npm run build` passou | Passou como etapa de `npm test` |
| Checagem de tipos | Produção e testes passaram em `typecheck` | Produção e testes passaram nas etapas de `npm test` |
| Lint | Passou sem warnings | Não há script ou configuração de lint |
| Dependências entre camadas | Passou; zero violações reportadas pelo dependency-cruiser | Não há verificador arquitetural configurado |
| OpenAPI | Documento validado e cobertura de operações aprovada | Não há OpenAPI |
| Suíte completa | **105 testes em 10 arquivos, todos aprovados** | **124 testes em 9 arquivos, todos aprovados** |
| Processo de teste | Saída natural com código 0 | Saída natural com código 0 |
| Carga incluída na suíte | Mil votos aceitos em cinco enquetes, sem perdas | Mil votos aceitos em cinco enquetes, sem perdas, com observação dos streams |
| Instalação nesta avaliação | Dependências locais já disponíveis; instalação limpa não repetida | `npm ci` passou, com 121 pacotes instalados |

Os [logs do validate](com-harness-validate.log) e [da suíte sem harness](without-harness-test.log) preservam os resultados. A suíte com harness levou 3,00 s no runner; a sem harness levou 25,41 s, além das etapas anteriores de compilação. **Esses tempos não medem desempenho da API**: a segunda suíte espera um heartbeat real de 15 segundos e executa arquivos em série; a primeira usa tempo virtual para esse cenário e permite paralelismo entre arquivos.

O registro anterior de execução em `without-harness/IMPLEMENTATION_PLAN.md` menciona 123 testes. A execução atual identificou 124; este relatório adota a quantidade efetivamente observada. Os dois testes OpenAPI executados na etapa `lint:openapi` também pertencem à suíte de 105 e não devem ser contados novamente.

## Arquitetura e direção das dependências

### Implementação com harness

A estrutura separa `domain`, `application` e `infra/http`, com composição em `main.ts`. O domínio concentra validação, aplicação síncrona de votos, encerramento e projeção do ranking. Ele retorna erros por um tipo discriminado `Result`; a tradução para status HTTP fica no adaptador. Isso permite reutilizar as regras sem carregar Express ou decisões de transporte.

`PollRegistry` coordena o ciclo de vida e `PollRuntime` concentra os fluxos RxJS. `Clock`, `SchedulerLike` e `IdGenerator` são portas explícitas, tornando tempo e geração de identificadores controláveis. O dependency-cruiser verifica dependências proibidas e ciclos; o ESLint restringe padrões RxJS, APIs diretas de tempo e práticas que enfraquecem a tipagem.

Há boa correspondência entre estrutura, regras documentadas e verificações executáveis. O custo é uma implementação mais extensa e um scheduler Node próprio, que precisa manter corretamente cancelamento, reagendamento, atrasos longos e execução síncrona para atraso zero. A suíte inclui testes desse adaptador, mas sua manutenção é uma responsabilidade adicional.

Evidências: [AGENTS.md](../com-harness/AGENTS.md), [regras de dependência](../com-harness/.dependency-cruiser.cjs), [ESLint](../com-harness/eslint.config.js), [portas](../com-harness/src/application/ports.ts) e [composição](../com-harness/src/main.ts).

### Implementação sem harness

A estrutura também é modular: `domain`, `polls` e `http`, com factory Express separada do servidor. `PollService`, `PollStore`, `PollRuntime` e `SseConnections` dividem comandos, armazenamento, publicação e conexões. Portanto, ausência de harness não significou ausência de arquitetura.

As fronteiras são mais permeáveis. `domain/types.ts` importa o tipo concreto `PollRuntime` e o incorpora em `PollState`, enquanto o runtime importa tipos do domínio. É uma dependência circular **no nível de tipos**, apagada na compilação, e não um ciclo executável comprovado. Mesmo assim, os tipos centrais passam a conhecer a implementação reativa. Além disso, `DomainError` carrega status HTTP e os validadores de domínio instanciam erros com esses códigos, acoplando negócio ao transporte.

Tempo e scheduler podem ser injetados, mas o serviço ainda escolhe defaults concretos e usa diretamente `randomUUID` e conversão com `Date`. Isso reduz a uniformidade da inversão de dependências. Não contraria a stack ou os contratos funcionais da SPECS, mas exige mais disciplina manual para preservar as fronteiras durante a evolução.

Evidências: [tipos centrais](../without-harness/src/domain/types.ts), [erros](../without-harness/src/domain/errors.ts), [validação](../without-harness/src/domain/validation.ts) e [serviço](../without-harness/src/polls/poll-service.ts).

## Coesão e encapsulamento

| Aspecto | Com harness | Sem harness |
| --- | --- | --- |
| Regras de votação | Concentradas em funções de domínio síncronas | Concentradas no serviço, junto à coordenação do runtime |
| Estado interno | Registro privado; rotas recebem resultados e observáveis | Store, serviço e estado são acessíveis por outras partes da aplicação |
| Transporte | Mapeamento HTTP separado dos erros de domínio | Status HTTP fazem parte dos erros de domínio |
| Temporalidade | Portas uniformes e heartbeat composto no fluxo reativo | Scheduler injetável no runtime; heartbeat com timer nativo no adaptador SSE |
| Enquetes encerradas | Registro aberto é substituído por metadados e ranking final | Estado completo e runtime parado permanecem no store |
| Testabilidade | Domínio puro, IDs e relógio controláveis | Boa inspeção operacional, com contadores internos de recursos |

A versão com harness tem maior coesão das regras de negócio e melhor ocultação do estado. A versão sem harness também separa responsabilidades, mas expõe mais detalhes: a rota de votos, por exemplo, acessa `service.store.get()` para preservar a precedência antes do parsing. Isso funciona, porém faz o transporte conhecer o armazenamento.

A retenção após fechamento favorece a versão com harness: conjuntos de votos, contagens de usuários e runtime deixam de fazer parte do registro conservado. A versão sem harness cancela os agendamentos, mas conserva essas estruturas. Como a SPECS permite manter enquetes encerradas em memória, essa diferença é uma oportunidade de eficiência, não uma violação automática da RN-11 ou prova de vazamento.

## Programação reativa e orientação a eventos

As duas soluções adotam uma abordagem híbrida apropriada ao problema: comandos alteram o estado em memória de modo síncrono e eventos propagam atualizações. A atomicidade decorre da ausência de suspensão entre validar e mutar, dentro de uma única instância Node; não depende de banco, broker ou execução distribuída.

Ambas mantêm um pipeline por enquete, throttle com bordas inicial e final, snapshot de conexão separado da janela, fechamento que ignora o throttle e isolamento entre enquetes. Também expõem observáveis em vez de Subjects públicos. A versão com harness usa `share()`; a versão sem harness mantém uma assinatura única do pipeline e distribui sua saída por um Subject privado. **A ausência de `share()` na segunda não implica processamento independente por cliente.**

Na versão com harness, o ranking é materializado antes do compartilhamento e o frame SSE é reutilizado por um cache `WeakMap`. Na versão sem harness, o ranking também é calculado uma vez por publicação, mas cada cliente serializa o próprio frame. O primeiro desenho economiza serialização; o segundo tira a distribuição do caminho síncrono do comando de voto.

Essa diferença é essencial para a RN-05. O envio total para N clientes continua exigindo trabalho proporcional a N em ambas. A implementação sem harness desloca esse trabalho para uma etapa agendada, preservando a independência da aceitação síncrona do voto em relação ao número de assinantes. Isso não garante latência constante sob saturação do event loop.

## Conformidade com as especificações

| Regra ou contrato | Com harness | Sem harness |
| --- | --- | --- |
| Seis operações HTTP, status e envelopes de erro | Evidência automatizada aprovada | Evidência automatizada aprovada |
| Strings preservadas, opções e duração válidas, zeros de configuração | Evidência aprovada; sem normalização | Evidência aprovada; sem normalização |
| RN-01 — idempotência | Coberta no domínio e HTTP, incluindo colisões | Coberta no serviço e concorrência HTTP |
| RN-02 — limite por usuário e enquete | Coberta, incluindo limite zero | Coberta, incluindo limite zero e rajada concorrente |
| RN-03 — isolamento | Coberto em tempo virtual e HTTP/SSE | Coberto em runtime, SSE e carga |
| RN-04 — throttle leading e trailing | Coberto com marbles e SSE real | Coberto com scheduler virtual, fronteiras e SSE real |
| RN-05 — sequência comum e custo de aceitação independente dos clientes | Compartilhamento correto; **desvio na distribuição síncrona**, reproduzido abaixo | Compartilhamento e distribuição fora do comando verificados |
| RN-06 — atomicidade, contagem e GET imediato | Evidência aprovada | Evidência aprovada |
| RN-07 — resiliência | Requisição inválida e falha de relógio antes da mutação; proteção local da projeção com `catchError` | Erros de requisição, falha injetada no serviço e falha de escrita de cliente |
| RN-08 — desconexão | Verifica cancelamento do heartbeat e sobrevivência de outro cliente | Verifica ciclos repetidos e contagem de conexões e assinantes |
| RN-09 — fechamento e disputa com votos | Evidência aprovada, inclusive prazo vencido antes do callback | Evidência aprovada, inclusive prazo vencido e corrida HTTP |
| RN-10 — evento final e EOF | Evidência aprovada com trailing pendente e conexão tardia | Evidência aprovada com trailing pendente e conexão tardia |
| RN-11 — cancelamento de recursos | Evidência aprovada para fechamento de enquetes | Evidência aprovada com inspeção explícita dos recursos |
| Carga de mil votos em cinco enquetes | Aprovada, com contagens finais exatas | Aprovada, incluindo convergência SSE e fechamento consistente |
| Heartbeat de 15 segundos | Tempo virtual e transmissão pelo adaptador HTTP | Tempo virtual e espera de 15 segundos em HTTP real |

As rotas implementam a precedência de erros exigida, incluindo `404` antes de interpretar JSON de voto em enquete inexistente e `400` antes de verificar fechamento quando o corpo é inválido. GET consulta o estado atual, sem depender da última publicação sujeita a throttle.

Há uma diferença de interpretação no comprimento das strings: a versão com harness conta pontos de código com `[...value].length`; a sem harness conta unidades UTF-16 com `string.length`, decisão documentada em seu README. Um título com 200 emojis é aceito pela primeira e rejeitado pela segunda. A SPECS não define a unidade de contagem; portanto, isso é uma ambiguidade contratual, não um erro atribuído unilateralmente. Convém fixar essa definição para que as implementações sejam equivalentes também nos limites Unicode.

## Qualidade dos testes

### Pontos fortes de cada suíte

A suíte com harness distingue testes puros de domínio, marbles da aplicação e integração HTTP. Os marbles verificam sequências, tempos de emissão e conclusão; outros casos verificam reaproveitamento do objeto publicado, cadência sem clientes, cancelamento de timers e consistência do ranking final. O OpenAPI tem um teste negativo que remove uma operação e confirma a falha da checagem de cobertura.

A suíte sem harness cobre mais situações operacionais: corpo que termina de chegar durante desligamento, shutdown idempotente, repetição de desconexões, escrita de cliente com falha, contagem explícita de timers e assinaturas, heartbeat real e carga observada por SSE. Seu teste de carga verifica a convergência dos streams, os rankings finais e a igualdade entre fechamento, GET e evento final.

Evidências: [marbles com harness](../com-harness/test/marble/pollRuntime.test.ts), [SSE com harness](../com-harness/test/http/sse.test.ts), [OpenAPI](../com-harness/test/http/openapi.test.ts), [ciclo de vida sem harness](../without-harness/test/lifecycle.test.ts), [SSE sem harness](../without-harness/test/sse.test.ts) e [carga sem harness](../without-harness/test/load.test.ts).

### Limites das evidências

**124 testes não demonstram, por si só, cobertura superior a 105.** Existem diferenças na parametrização e no agrupamento dos cenários. A vantagem operacional da suíte sem harness decorre dos comportamentos que ela observa, especialmente shutdown e recursos, e não apenas da contagem.

Na versão com harness, a carga não abre streams; portanto, não exercita o custo de distribuir atualizações durante a rajada. Também não há teste de ausência de publicação dentro da chamada de voto nem da retomada de uma criação após descarte. São lacunas diretamente relacionadas aos dois problemas reproduzidos nesta revisão.

Os testes de resiliência das duas versões exercitam falhas de requisição, mas não demonstram todas as falhas possíveis dentro da projeção compartilhada. A proteção `catchError` da primeira é uma defesa adicional; sua presença não substitui um teste que provoque a falha no ponto protegido.

Não foram produzidas métricas de cobertura de linhas ou branches, testes de mutação ou benchmark comparável de latência e memória. As suítes validam o cenário de carga exigido; não estabelecem capacidade máxima de produção. A exigência de escrever testes antes da implementação, presente no AGENTS, tampouco pode ser comprovada apenas pelo código final e pelos commits agregados.

## Problemas reproduzidos e desvios arquiteturais

### Publicação síncrona no comando de voto com harness

**Classificação:** não conformidade com a cláusula de custo da RN-05.

Em [PollRuntime.vote](../com-harness/src/application/pollRuntime.ts), `stateSubject.next()` é chamado antes do retorno do comando. O primeiro evento passa imediatamente pela borda inicial do throttle e aciona os assinantes de forma síncrona. O adaptador [SSE](../com-harness/src/infra/http/sse.ts) escreve a resposta dentro desse callback.

A reprodução usa um voto aceito e assinantes do fluxo público; exclui o snapshot inicial da contagem. Não mede tempo de CPU: conta quantos callbacks são executados antes do retorno do voto.

| Assinantes | Com harness — callbacks dentro do voto | Sem harness — callbacks dentro do voto | Sem harness — callbacks após executar o scheduler |
| --- | --- | --- | --- |
| 1 | 1 | 0 | 1 |
| 10 | 10 | 0 | 10 |
| 100 | 100 | 0 | 100 |

O compartilhamento evita recalcular o ranking para cada cliente, mas não retira a distribuição do comando. Logo, no caminho de emissão imediata, o trabalho síncrono de aceitação cresce com os assinantes. A versão sem harness agenda a publicação em `changed()` e possui um teste específico de ausência de escritas SSE na pilha do voto.

### Criação de enquete após descarte com harness

**Classificação:** problema de robustez do ciclo de vida. O contrato de shutdown global não está detalhado na SPECS; o achado não foi contado como segunda violação funcional nem como violação automática da RN-11, que trata de fechamento de enquetes.

A reprodução inicia `POST /polls`, envia apenas parte do JSON, chama `server.close()` e o descarte da aplicação, e então termina de enviar o corpo. Ela segue a ordem do desligamento de produção e usa duração de 60 segundos para tornar observável a possibilidade de recriar um timer.

- **Com harness:** retorna **201** e cria uma enquete depois do descarte. `PollRegistry.dispose()` esvazia o registro, mas não marca o serviço como encerrado; `create()` continua operando e pode agendar novos recursos.
- **Sem harness:** retorna **503 SERVICE_UNAVAILABLE**. `PollStore.assertActive()` impede a recriação de estado após descarte. Há regressão automatizada para esse cenário.

Além disso, o servidor sem harness prevê um prazo de dois segundos para conexões remanescentes; o bootstrap com harness não tem prazo equivalente. Essa diferença reforça a avaliação de robustez, sem constituir uma contagem adicional de erro.

### Dois desvios de separação na versão sem harness

Para a comparação manual, foram usados dois critérios comuns: **tipos do domínio não dependem do runtime concreto** e **erros do domínio não definem status HTTP**. Os critérios medem independência de camadas; não são novos requisitos funcionais impostos à SPECS.

| Critério | Com harness | Sem harness |
| --- | --- | --- |
| Domínio independente do runtime | Atende | Desvio: `domain/types.ts` importa `PollRuntime` e o inclui em `PollState` |
| Erros de negócio independentes de HTTP | Atende | Desvio: `DomainError.status` e validadores com status HTTP |

São **zero desvios na primeira e dois na segunda, nessa rubrica limitada**. Isso não significa que o verificador do harness tenha sido executado sobre a segunda, nem que exista um total universal de violações arquiteturais. A ausência de lint na segunda foi registrada como ausência de proteção automática e não como um terceiro desvio de código.

### Risco adicional de clientes lentos

O adaptador SSE com harness ignora o retorno booleano de `res.write()`. Ele trata exceções e desconexões, mas não impõe uma política explícita para quando o buffer de saída cresce. A versão sem harness desconecta o cliente quando `write()` retorna `false`, limitando a retenção por conexão, com o custo de interromper consumidores que não acompanhem a emissão.

Esse ponto foi identificado por inspeção. Não houve ensaio de cliente lento nem medição de crescimento de heap; por isso, ele permanece como risco operacional e não entra na contagem de defeitos reproduzidos.

## Harness e qualidade da entrega

O requisito de preparar instruções para agentes, regras arquiteturais, testes, lint e scripts de validação está materializado em `com-harness/`. `npm run validate` reúne checagem de tipos, lint, arquitetura, OpenAPI e testes. A variante sem harness mantém build e testes, mas não possui uma barreira automática equivalente para estilo, uso de RxJS e direção das dependências.

O harness tem limites importantes. O dependency-cruiser protege importações, mas não verifica custo do fan-out. O lint restringe padrões perigosos, mas não prova atomicidade ou encerramento de todos os recursos. O teste OpenAPI valida o documento e a correspondência de métodos e caminhos, mas não valida automaticamente cada resposta real contra seu schema. Os dois defeitos reproduzidos passam por todas as verificações atuais.

Na versão avaliada, `com-harness/AGENTS.md` indicava `SPECS.md` na raiz, enquanto a especificação estava em `docs/SPECS.md`. O caminho foi corrigido após a avaliação, sem alterar as implementações avaliadas.

A documentação tem qualidades diferentes. A versão com harness oferece contrato OpenAPI e decisões coerentes com sua arquitetura. A versão sem harness tem um README operacional mais completo, incluindo execução, configuração, exemplos de rotas, SSE, limites e matriz de testes. Ambas possuem planos e registros de decisões dentro da quantidade de tópicos solicitada.

## Quantidade de erros e intervenções humanas

| Métrica | Com harness | Sem harness | Interpretação |
| --- | --- | --- | --- |
| Testes existentes que falharam na execução válida | 0 de 105 | 0 de 124 | Resultado das suítes entregues |
| Não conformidades funcionais reproduzidas nesta revisão | 1 | 0 identificadas | RN-05; não é prova de ausência de outros defeitos |
| Problemas adicionais de robustez reproduzidos | 1 | 0 identificados | Criação após descarte |
| Desvios nos dois critérios arquiteturais comuns | 0 | 2 | Dependência de runtime e status HTTP no domínio |
| Violações reportadas pelo verificador arquitetural próprio | 0 | Não mensurado | A segunda não possui esse verificador |
| Erros encontrados e corrigidos durante o desenvolvimento | Não mensurado | Não mensurado | Falta histórico detalhado de achados e correções |
| Intervenções humanas de correção ou orientação | Não mensurado | Não mensurado | Não há diário ou transcrição que permita contagem |
| Tempo de desenvolvimento, tokens e rodadas de revisão | Não mensurado | Não mensurado | Não inferíveis dos arquivos finais |

Os resultados das categorias não devem ser somados para declarar um empate de “dois erros para cada lado”: um desvio de projeto, uma falha funcional e um problema de shutdown têm naturezas e consequências diferentes.

Os planos e o histórico disponível não quantificam a participação humana em cada execução. Acionar um agente, receber uma revisão automática e editar manualmente código são ações distintas; contar commits ou arquivos `DECISIONS.md` como intervenções produziria uma métrica sem fundamento.

## Limites do experimento

Há uma implementação por condição. Os registros disponíveis não comprovam o modelo e o nível de raciocínio usados em ambas as condições. Não há base para atribuir causalmente todos os resultados à presença do harness.

As condições também diferem no conteúdo orientador. O plano sem harness é bastante detalhado e inclui arquitetura, rastreabilidade e procedimentos de teste; ele funciona como orientação substancial mesmo sem `AGENTS.md` ou ferramentas de enforcement. A comparação efetiva é entre **orientação com verificações adicionais** e **orientação sem essas verificações**, não entre desenvolvimento guiado e ausência de planejamento.

OpenAPI é uma exigência adicional do harness. Sua presença demonstra uma vantagem documental dessa condição, mas sua ausência na outra não viola a SPECS. As versões TypeScript também diferem: 5.5.4 na primeira e série 5.9 na segunda. A segunda ativa `noUncheckedIndexedAccess`; portanto, maior rigor de tipagem não é exclusivo do harness.

O histórico visível agrega cada implementação em um commit principal, seguido de merge. Ele não comprova uma sequência teste-falha-correção nem permite reconstruir a quantidade de revisões. Também não estabelece, por si só, quais arquivos de configuração do harness já estavam fixados antes da implementação e quais foram produzidos ou ajustados na mesma entrega.

## Recomendações e conclusão

As melhorias de maior impacto são:

1. **Corrigir a RN-05 na versão com harness:** manter a mutação síncrona e agendar a distribuição, acrescentando um teste que conte notificações dentro da chamada de voto.
2. **Bloquear comandos após descarte nessa versão:** adotar estado de encerramento e testar requisições com corpo parcial durante shutdown; prever prazo finito para conexões remanescentes.
3. **Aprimorar o tratamento de SSE lento:** definir e testar uma política de buffer, drenagem ou desconexão na versão com harness.
4. **Desacoplar o domínio sem harness:** remover a dependência de `PollRuntime` dos tipos de negócio e mapear status HTTP no adaptador.
5. **Usar uma suíte de aceitação comum:** executar os mesmos cenários de RN-01 a RN-11, carga, heartbeat real e recursos sobre ambas, além dos testes internos de cada projeto.
6. **Registrar o processo experimental:** para cada condição, preservar prompt, estado inicial do harness, modelo, execução, achados de revisão, correções e intervenções humanas com critério uniforme. Repetir o experimento permitiria comparar distribuições, em vez de apenas dois resultados finais.

**O principal ganho demonstrado pelo harness é tornar parte da arquitetura verificável e repetível.** A implementação com harness apresenta domínio mais independente, portas explícitas e validação integrada. Sua suíte, porém, deixa passar uma exigência de custo do processamento e uma falha de descarte. A implementação sem harness demonstra que um plano detalhado e testes operacionais podem produzir boa conformidade e robustez, embora com fronteiras arquiteturais menos protegidas.

O trabalho entrega as duas versões e os mecanismos centrais pedidos. A comparação final evidencia vantagens e limitações concretas, mas a conclusão sobre redução de erros ao longo do desenvolvimento ou de intervenções humanas permanece em aberto até existir instrumentação dessas métricas.

## Reprodução da avaliação

Na raiz do repositório, com Node.js 20 ou superior e dependências instaladas:

```bash
cd com-harness
npm run validate
npm run build
cd ../without-harness
npm test
cd ..
node docs/diagnostico.cjs
```

O diagnóstico adicional é separado das suítes originais, usa as implementações reais compiladas e encerra os recursos que cria. Requer permissão para abrir servidores HTTP locais. Ele registra comportamentos observados; não foi projetado como uma suíte que falha automaticamente quando encontra os problemas.

O [inventário](inventario.json) registra 13 arquivos TypeScript de produção em cada versão: 679 linhas com harness e 476 sem harness, contando comentários e linhas em branco. Os arquivos TypeScript sob `test/`, incluindo helpers, têm 931 e 938 linhas, respectivamente. Essas medidas descrevem o volume entregue e não servem, isoladamente, como notas de qualidade ou produtividade.
