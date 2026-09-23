// Upstream, workflows.ts is the expense's control flow: create, wait for a
// signal with a timeout, pay. Here that flow is the certified machine in
// ../machine, and the workflows module is the governed host, re-exported.
export * from '@cognitive-fab/polyflow-temporal/workflows';
