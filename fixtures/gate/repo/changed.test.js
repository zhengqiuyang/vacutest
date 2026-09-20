const user = { name: 'a' };
test('user roundtrip', () => {
  expect(user).toBe(user);
});
