import neo4j from 'neo4j-driver';

if (!process.env.NEO4J_URI) {
  throw new Error('NEO4J_URI environment variable is required');
}

if (!process.env.NEO4J_USERNAME) {
  throw new Error('NEO4J_USERNAME environment variable is required');
}

if (!process.env.NEO4J_PASSWORD) {
  throw new Error('NEO4J_PASSWORD environment variable is required');
}

export const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD),
  { disableLosslessIntegers: true }
);

export default driver;
