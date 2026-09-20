test('pre-existing vacuous debt', () => {
  const r = compute();
  expect(r).toBeDefined();
});
function compute() { return 1; }
test('vacuous added by patch', () => {
  const v = compute();
  expect(v).toBeDefined();
});
test('good added by other patch', () => {
  expect(compute() + 1).toBe(2);
});
