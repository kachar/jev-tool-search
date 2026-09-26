import { experimental_evaluate as evaluate } from 'ai';
const t = Date.now();
const r = await evaluate({
  model: 'typesafe-ai/jev',
  state: 'My card was charged twice for one order.',
  questions: { route: { type: 'choice', instructions: 'Route this ticket.', criteria: { billing: 'payment problems', shipping: 'delivery problems', technical: 'bugs' } } },
});
console.log(Date.now() - t, 'ms', JSON.stringify(r.answers), JSON.stringify(r.usage), JSON.stringify(r.providerMetadata));
