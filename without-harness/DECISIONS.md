# Decisões implementadas

1. Factory Express separada do bootstrap HTTP: cada instância possui estado próprio, descarte explícito e desligamento idempotente com prazo finito para conexões remanescentes.
2. `Map`/`Set` por enquete preservam identificadores opacos e dados somente em memória. Resultados encerrados permanecem disponíveis enquanto a aplicação existir.
3. Votos verificam e alteram estado de modo síncrono. `version` é o único total de votos aceitos; projeções novas preservam snapshots anteriores e a ordem original nos empates.
4. Cada enquete mantém um pipeline RxJS quente com leading/trailing e agendamento coalescido. A distribuição aos clientes ocorre fora da pilha de aceitação do voto; snapshots de conexão não afetam a janela compartilhada.
5. Um único fechamento cancela publicação, throttle e prazo automático antes do evento final, que usa os contadores atuais. Verificações síncronas de prazo impedem aceitar votos atrasados.
6. Parsing JSON local às rotas preserva a precedência contratual dos erros. Strings usam comprimento UTF-16, campos extras são ignorados e configuração explicitamente inválida impede a inicialização.
7. Testes combinam relógios controlados e HTTP em porta efêmera, com concorrência, mil votos reais, heartbeat de 15 segundos e inspeção de recursos. Vitest 4 com Vite 6 mantém compatibilidade com Node 20 e lockfile reproduzível.
