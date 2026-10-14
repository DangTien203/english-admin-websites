// Minimal jest setup. The lookup/upstream unit tests need no database, network or secrets.
// (The older DB-backed suites enforced JWT_SECRET here; add that back when those tests return.)
process.env.NODE_ENV = 'test';
