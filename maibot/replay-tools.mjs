import { serveLookup } from '../src/mcp/jinhua-stdio.mjs';
import { lookupSpec, runLookup } from '../src/mcp/jinhua-tools.mjs';
import { invokeFixture, toolNames } from './replay-data.mjs';

serveLookup(lookupSpec(false), (args, signal) => runLookup(args, {
  signal, mode: args?.mode, invoke: invokeFixture, names: toolNames,
}));
