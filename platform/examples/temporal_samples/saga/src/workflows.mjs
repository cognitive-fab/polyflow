// Upstream, workflows.ts is openAccount's control flow: four steps in a try,
// an array of compensations run in reverse in the catch, errors in
// compensation swallowed. Here that flow is the certified machine in
// ../machine (and ../machine-v2), and the workflows module is the governed
// host, re-exported.
export * from '@cognitive-fab/polyflow-temporal/workflows';
