# Decisões de implementação

- O domínio é síncrono e devolve erros como valores. A aplicação coordena o estado e os streams, e o Express cuida da tradução para HTTP e SSE.
- Cada enquete aberta usa mapas de contagem e um conjunto de IDs aceitos. A validação final e a atualização dos votos, da versão e do horário ocorrem na mesma operação síncrona.
- Um pipeline RxJS por enquete mantém o throttle leading e trailing entre conexões. O snapshot inicial lê o estado atual e cada atualização compartilhada é calculada e serializada uma vez.
- O `Clock` e o `SchedulerLike` injetados permitem testar o tempo virtual. O agendador Node usa `unref()` e cada conexão controla seu próprio heartbeat.
- O encerramento cancela o ranking pendente e entrega o estado final. O registro conserva o ranking e os metadados para consultas e libera o runtime de votação.
- O `openapi.yaml` descreve o contrato e o harness confere os métodos e caminhos registrados no Express. A suíte HTTP usa portas efêmeras e gerencia seus clientes, servidores e timers.
