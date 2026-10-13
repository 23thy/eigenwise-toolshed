import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isInScope, ticketCommitScope, validateCommitRangeScope } from '../commit-scope';
import type { CompletedVerificationCapture } from '../kernel/verification';

export const WORK_KINDS = ['new-behavior', 'behavior-preserving-refactor', 'inherited-read-only', 'docs', 'type-annotation-only', 'fixture-only'] as const;
export type WorkKind = typeof WORK_KINDS[number];
export type SourceOriginInput = Readonly<{ ref: string; preparedAt: string; commit: string; captureId?: string }>;
export type WorkDeclaration = Readonly<{ kind: WorkKind; sources: readonly SourceOriginInput[] }>;
type ProducerDispatch = Readonly<{
  preparedAt: string; terminalAt?: string; outcome: string; baseCommit: string; commit?: string;
  declaredFiles: readonly string[]; sanctionedCommits?: readonly string[];
  verificationRequirement?: { command?: string }; tokenPrefix?: string;
}>;
export type ProvenanceProducer = Readonly<{
  id: string; ref: string; claim?: { by?: string } | null; dispatchNonce?: string | null;
  dispatch?: ProducerDispatch & { attempts?: readonly ProducerDispatch[] };
  submission?: { commit: string; base: string; commits: readonly string[]; admittedScope: readonly string[] } | null;
  verificationCaptures?: readonly CompletedVerificationCapture[];
}>;
type FileIdentity = Readonly<{ path: string; sha256: string | null }>;
export type SourceOrigin = Readonly<{
  input: SourceOriginInput; producerId: string; generation: ProducerDispatch; inheritedTips?: readonly string[];
  status: 'submitted-unaccepted' | 'preparation-unaccepted';
  files: readonly FileIdentity[]; capture?: CompletedVerificationCapture;
}>;
export type WorkProvenance = Readonly<{
  kind: WorkKind; authority: 'main-thread-attestation'; sessionId: string;
  execution: 'UNVERIFIED'; quality: 'UNVERIFIED'; admission: 'UNVERIFIED';
  sources: readonly SourceOrigin[];
}>;
type ProducerLookup = (ref: string) => ProvenanceProducer | null;

function requireFact(valid: boolean, reason: string): asserts valid {
  if (!valid) throw new Error(`work provenance refused: ${reason}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function immutableCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}
function sourceInput(value: unknown): value is SourceOriginInput {
  if (!record(value)) return false;
  return [text(value.ref), text(value.preparedAt), immutableCommit(value.commit),
    value.captureId === undefined || text(value.captureId),
    Object.keys(value).every(field => ['ref', 'preparedAt', 'commit', 'captureId'].includes(field))].every(Boolean);
}
export function workDeclaration(value: unknown): WorkDeclaration {
  requireFact(record(value), 'declaration must be an object');
  const kind = WORK_KINDS.find(candidate => candidate === value.kind);
  requireFact(kind !== undefined, 'unknown work kind');
  requireFact(Array.isArray(value.sources) && value.sources.length <= 20 && value.sources.every(sourceInput), 'invalid bounded sources');
  requireFact(Object.keys(value).every(field => ['kind', 'sources'].includes(field)), 'unknown declaration field');
  return { kind, sources: value.sources.map(source => ({ ...source })) };
}
export function authorizeWorkDeclaration(value: unknown, sessionId: unknown, granted: boolean, active: boolean): void {
  if (value === undefined) return;
  requireFact(granted && text(sessionId), 'main-thread MCP grant and runtime session required; actor labels grant nothing');
  requireFact(!active, 'late declaration cannot change an existing prepared or executing generation');
}
function git(root: string, argumentsList: readonly string[], input?: string): Buffer {
  return execFileSync('git', argumentsList, { cwd: root, windowsHide: true, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
}
function gitLines(root: string, argumentsList: readonly string[], input?: string): string[] {
  return git(root, argumentsList, input).toString().trim().split(/\r?\n/).filter(Boolean);
}
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function committedFile(root: string, commit: string, file: string): FileIdentity {
  const exists = git(root, ['ls-tree', '--name-only', commit, '--', file]).toString().trim();
  return { path: file, sha256: exists ? sha256(git(root, ['show', `${commit}:${file}`])) : null };
}
// A branch holding none of this generation's commits was merged in whole, like the trial branch a producer
// fast-forwards as its authorized first step (SQ-3674), so that history is inherited, never authored here.
function wholeInheritedBranchTips(root: string, baseCommit: string, ownedInRange: readonly string[]): string[] {
  return gitLines(root, ['for-each-ref', '--format=%(objectname)', '--no-merged', baseCommit,
    ...ownedInRange.flatMap(commit => ['--no-contains', commit]), 'refs/heads', 'refs/remotes']);
}
type SourceRange = Readonly<{ authored: string[]; inheritedTips: string[] }>;
function sourceRange(root: string, generation: ProducerDispatch, input: SourceOriginInput, owned: readonly string[], recordedTips?: readonly string[]): SourceRange {
  requireFact(immutableCommit(generation.baseCommit), 'producer needs an immutable native base');
  git(root, ['merge-base', '--is-ancestor', generation.baseCommit, input.commit]);
  const range = gitLines(root, ['rev-list', '--reverse', '--parents', `${generation.baseCommit}..${input.commit}`]).map(line => {
    const [commit = '', ...parents] = line.split(' ');
    return { commit, parents };
  });
  const commits = range.map(entry => entry.commit);
  const exclusions = recordedTips ?? wholeInheritedBranchTips(root, generation.baseCommit, commits.filter(commit => owned.includes(commit)));
  const authored = new Set(gitLines(root, ['rev-list', '--stdin'], [input.commit, `^${generation.baseCommit}`, ...exclusions.map(tip => `^${tip}`), ''].join('\n')));
  const inherited = range.filter(entry => !authored.has(entry.commit));
  return { authored: commits.filter(commit => authored.has(commit)),
    inheritedTips: inherited.filter(entry => !inherited.some(other => other.parents.includes(entry.commit))).map(entry => entry.commit) };
}
function requireSourceFacts(generation: ProducerDispatch, input: SourceOriginInput): void {
  const fields: readonly (keyof ProducerDispatch)[] = ['baseCommit', 'declaredFiles',
    ...(generation.outcome === 'released' ? ['sanctionedCommits'] as const : []),
    ...(input.captureId ? ['verificationRequirement', 'tokenPrefix'] as const : [])];
  for (const field of fields) {
    requireFact(generation[field] != null, `producer generation ${input.preparedAt} missing ${field}`);
  }
}
function sourceGeneration(producer: ProvenanceProducer, input: SourceOriginInput): ProducerDispatch {
  const dispatch = producer.dispatch;
  requireFact(dispatch !== undefined, 'producer has no native generation');
  const { attempts = [] } = dispatch;
  const generation = [dispatch, ...attempts.slice().reverse()].find(candidate => candidate.preparedAt === input.preparedAt);
  requireFact(generation !== undefined && Boolean(generation.terminalAt), 'producer generation mismatch');
  requireSourceFacts(generation, input);
  requireFact(generation === dispatch || generation.outcome !== 'submitted' || generation.commit === producer.submission?.commit,
    `historical submitted generation ${input.preparedAt} candidate ${generation.commit} differs from current submission ${producer.submission?.commit}`);
  requireFact(!producer.claim?.by && !producer.dispatchNonce, 'producer is still active');
  requireFact(['released', 'submitted'].includes(generation.outcome), 'producer must be released preparation or submitted source');
  return generation;
}
function ownedCommits(producer: ProvenanceProducer, generation: ProducerDispatch): readonly string[] {
  return (generation.outcome === 'submitted' ? producer.submission?.commits : generation.sanctionedCommits) ?? [];
}
function sourceOwnership(producer: ProvenanceProducer, generation: ProducerDispatch, input: SourceOriginInput, commits: readonly string[], owned: readonly string[]): void {
  requireFact(owned.includes(input.commit) && commits.length > 0, 'commit lacks native producer ownership');
  requireFact(commits.every(commit => owned.includes(commit)), 'range includes work not owned by this producer');
  requireFact(generation.outcome !== 'submitted' || producer.submission?.commit === input.commit, 'submitted candidate mismatch');
}
function sourceCapture(producer: ProvenanceProducer, input: SourceOriginInput): CompletedVerificationCapture | undefined {
  if (!input.captureId) return;
  const capture = producer.verificationCaptures?.find(candidate => candidate.id === input.captureId);
  requireFact(capture !== undefined, 'capture identity is unavailable');
  requireFact(capture.candidate.source === 'git' && capture.candidate.value === input.commit, 'capture source mismatch');
  requireFact(Boolean(capture.command.trim()) && Boolean(capture.dispatchNonce), 'capture needs command and nonce identities');
  compatibleSourceCapture(capture, sourceGeneration(producer, input));
  return capture;
}
function compatibleSourceCapture(capture: CompletedVerificationCapture, generation: ProducerDispatch): void {
  requireFact(capture.command === generation.verificationRequirement?.command, 'capture command is incompatible with producer generation');
  requireFact(Boolean(generation.tokenPrefix) && capture.dispatchNonce.startsWith(String(generation.tokenPrefix)), 'capture nonce is incompatible with producer generation');
  const completed = Date.parse(capture.completedAt);
  requireFact(completed >= Date.parse(generation.preparedAt) && completed <= Date.parse(String(generation.terminalAt)), 'historical capture cannot be rebound to a different generation');
}
function observeSource(root: string, input: SourceOriginInput, lookup: ProducerLookup, recordedTips?: readonly string[]): SourceOrigin {
  const producer = lookup(input.ref);
  requireFact(producer !== null, 'native producer is unavailable');
  const generation = sourceGeneration(producer, input);
  const owned = ownedCommits(producer, generation);
  const { authored, inheritedTips } = sourceRange(root, generation, input, owned, recordedTips);
  sourceOwnership(producer, generation, input, authored, owned);
  const scope = validateCommitRangeScope(root, authored, ticketCommitScope(generation.declaredFiles, generation.declaredFiles, producer.ref));
  requireFact(scope.ok, 'source range escapes native declared scope');
  return { input, producerId: producer.id, generation, ...(inheritedTips.length ? { inheritedTips } : {}), status: generation.outcome === 'submitted' ? 'submitted-unaccepted' : 'preparation-unaccepted',
    files: scope.paths.map(file => committedFile(root, input.commit, file)), capture: sourceCapture(producer, input) };
}
export function prepareWorkProvenance(root: string, declaration: WorkDeclaration | undefined, sessionId: string, lookup: ProducerLookup): WorkProvenance | undefined {
  if (!declaration) return;
  return structuredClone({ kind: declaration.kind, authority: 'main-thread-attestation', sessionId,
    execution: 'UNVERIFIED', quality: 'UNVERIFIED', admission: 'UNVERIFIED',
    sources: declaration.sources.map(input => observeSource(root, input, lookup)) });
}
function workingFile(root: string, file: FileIdentity): FileIdentity {
  const location = path.join(root, file.path);
  return { path: file.path, sha256: fs.existsSync(location) ? sha256(fs.readFileSync(location)) : null };
}
function unchangedSource(root: string, source: SourceOrigin, lookup: ProducerLookup): void {
  requireFact(JSON.stringify(source) === JSON.stringify(observeSource(root, source.input, lookup, source.inheritedTips ?? [])), 'source generation or capture mutated');
  requireFact(source.files.every(file => workingFile(root, file).sha256 === file.sha256), 'source/test bytes are incompatible with frozen origin');
}
export function ownedWorkPaths(root: string, provenance: WorkProvenance | undefined, paths: readonly string[], lookup: ProducerLookup): string[] {
  if (!provenance) return [...paths];
  provenance.sources.forEach(source => unchangedSource(root, source, lookup));
  const inherited = new Set(provenance.sources.flatMap(source => source.files.map(file => file.path)));
  const owned = paths.filter(file => !inherited.has(file));
  requireFact(provenance.kind !== 'inherited-read-only' || owned.every(file => isInScope(file, ['.release/unreleased/'])), 'inherited-read-only declaration has new owned work');
  return owned;
}
export function provenanceAdmissionHold(provenance: WorkProvenance | undefined): { ok: false; reason: string; message: string } | undefined {
  if (!provenance) return;
  return { ok: false, reason: 'work_provenance_unverified', message: 'Frozen work provenance is a factual declaration only. Execution, quality and source admission remain UNVERIFIED; checkpoint and release preparation, never submit it as accepted work.' };
}
