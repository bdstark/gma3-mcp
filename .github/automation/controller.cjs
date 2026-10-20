// SPDX-License-Identifier: MIT
'use strict';
const cp = require('node:child_process');
const OWNER = 'bdstark';
const REPOS = new Set(['gma3-mcp', 'gma3-beat-sync', 'gma3-phrase-sync']);
const BOT = 'chatgpt-codex-connector[bot]';
const RECEIPT = '<!-- independent-review:v1 ';
const SHA = /^[a-f0-9]{40}$/;
const SENSITIVE = /(^|\/)(AGENTS\.md|\.github|\.codex)(\/|$)/;
function official(comments, head, securityRequired = false) {
  const summaries = comments.filter(c => c.user?.login === BOT && c.user?.type === 'Bot' && c.body?.includes('<!-- codex-review-state:v1 '));
  const latest = summaries.sort((a,b) => b.id-a.id)[0];
  if (!latest) return false;
  try {
    const state = JSON.parse(latest.body.match(/<!-- codex-review-state:v1 (.*?) -->/s)[1]);
    const clean = s => s?.commit_sha === head && s.status === 'completed' && s.has_any_findings === false && s.has_unresolved_findings === false;
    return clean(state.code_review) && (securityRequired ? clean(state.security_review) : (!state.security_review?.commit_sha || clean(state.security_review)));
  } catch { return false; }
}
function verdict(raw, head, base) {
  let v;
  try { v = JSON.parse(raw); } catch { throw Error('Independent review did not return JSON'); }
  if (!v || v.head_sha !== head || v.base_sha !== base || !['ready','changes_requested','incomplete'].includes(v.verdict) || typeof v.summary !== 'string' || !Array.isArray(v.findings) || v.findings.length > 50) throw Error('Invalid independent review provenance or verdict');
  for (const f of v.findings) {
    if (!Number.isInteger(f.priority) || f.priority < 0 || f.priority > 3 || typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.split('/').includes('..') || !Number.isInteger(f.line) || f.line < 1 || typeof f.title !== 'string' || typeof f.body !== 'string') throw Error('Invalid finding');
  }
  if (v.verdict === 'ready' && v.findings.length) throw Error('Ready verdict contains findings');
  return v;
}
function eligible(pr, repo) {
  return pr.state === 'open' && !pr.draft && pr.user?.login === OWNER && pr.head.repo?.full_name === repo && pr.base.ref === 'main' && SHA.test(pr.head.sha) && SHA.test(pr.base.sha);
}
function receipt(review, head, base) {
  if (review.user?.login !== 'github-actions[bot]' || review.user?.type !== 'Bot' || review.commit_id !== head) return null;
  try {
    const r = JSON.parse(review.body.split(RECEIPT)[1].split(' -->')[0]);
    return r.head === head && r.base === base && ['ready','changes_requested','incomplete'].includes(r.verdict) && Number.isSafeInteger(r.run) ? r : null;
  } catch { return null; }
}
async function deleteBranchAtomically(repo, branch, sha) {
  if (!process.env.GH_AUTOMATION_TOKEN) throw Error('Missing branch cleanup token');
  cp.execFileSync('git',['check-ref-format',`refs/heads/${branch}`]);
  const auth=Buffer.from(`x-access-token:${process.env.GH_AUTOMATION_TOKEN}`).toString('base64');
  // Git's receive-pack compares the old object ID atomically; a later push makes this lease fail.
  cp.execFileSync('git',['-C','policy','push',`--force-with-lease=refs/heads/${branch}:${sha}`,`https://github.com/${repo}.git`,`:refs/heads/${branch}`],{env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:`AUTHORIZATION: basic ${auth}`},stdio:['ignore','pipe','pipe']});
}
async function main({github:g, context:c, core, mode, deleteBranch = deleteBranchAtomically}) {
  const r = c.repo;
  if (r.owner !== OWNER || !REPOS.has(r.repo)) throw Error('Repository is outside the authorized allowlist');
  const full = `${r.owner}/${r.repo}`;
  const all = (fn, args) => g.paginate(fn, {...r, per_page:100, ...args});
  const getPR = async number => (await g.rest.pulls.get({...r,pull_number:number})).data;
  const comments = n => all(g.rest.issues.listComments,{issue_number:n});
  const reviews = n => all(g.rest.pulls.listReviews,{pull_number:n});
  const files = n => all(g.rest.pulls.listFiles,{pull_number:n});
  async function reviewEvidence(pr) {
    for (const rv of (await reviews(pr.number)).sort((a,b)=>b.id-a.id)) {
      const proof = receipt(rv,pr.head.sha,pr.base.sha);
      if (!proof) continue;
      const run = (await g.rest.actions.getWorkflowRun({...r,run_id:proof.run})).data;
      if (run.path === '.github/workflows/pr-automation.yml' && run.status === 'completed' && run.conclusion === 'success' && run.repository.full_name === full) return proof;
    }
    return null;
  }
  if (mode === 'prepare') {
    const p=c.payload;
    // Ignore ordinary comments and other workflow activity, avoiding feedback loops and API-key abuse.
    if (c.eventName === 'issue_comment' && !(p.comment?.user?.login === BOT && p.comment.user.type === 'Bot') && !(p.comment?.user?.login === OWNER && p.comment.body?.trim() === '/accept')) { core.setOutput('matrix','[]'); return; }
    if (c.eventName === 'pull_request_review' && p.review?.user?.login !== BOT) { core.setOutput('matrix','[]'); return; }
    if (c.eventName === 'workflow_run' && !['pull_request','dynamic'].includes(p.workflow_run?.event)) { core.setOutput('matrix','[]'); return; }
    const number = p.pull_request?.number || (p.issue?.pull_request && p.issue.number) || Number(p.inputs?.pr_number || 0);
    const candidates = number ? [await getPR(number)] : await all(g.rest.pulls.list,{state:'open'});
    const matrix=[];
    for (let pr of candidates) {
      pr=await getPR(pr.number);
      if (pr.merged && pr.head.repo?.full_name === full) { matrix.push({number:pr.number,head:pr.head.sha,base:pr.base.sha,review:false,cleanup:true}); continue; }
      if (!eligible(pr,full)) continue;
      const changed=await files(pr.number);
      // Policy/workflow changes need a human merge, including this bootstrap PR.
      if (pr.changed_files > 3000 || changed.some(f=>SENSITIVE.test(f.filename) || (f.previous_filename && SENSITIVE.test(f.previous_filename)))) continue;
      matrix.push({number:pr.number,head:pr.head.sha,base:pr.base.sha,review:c.eventName === 'workflow_dispatch' || !(await reviewEvidence(pr)),cleanup:false});
    }
    core.setOutput('matrix',JSON.stringify(matrix));
    return;
  }
  const n=Number(process.env.PR_NUMBER);
  let pr=await getPR(n);
  async function cleanup() {
    if (!pr.merged || pr.head.repo?.full_name !== full || pr.head.ref === pr.base.ref || ['main','master'].includes(pr.head.ref)) return;
    const children=(await all(g.rest.pulls.list,{state:'open',base:pr.head.ref}));
    for (const child of children) {
      await g.rest.pulls.update({...r,pull_number:child.number,base:pr.base.ref});
      await g.rest.issues.createComment({...r,issue_number:child.number,body:`Base retargeted after #${pr.number} merged. Rebase and rerun checks before merge. The parent branch is retained for recovery.`});
    }
    if (children.length) { core.info('Retargeted stacked PRs; retained parent branch. Dispatch cleanup again after rebasing.'); return; }
    const branch=(await g.rest.repos.getBranch({...r,branch:pr.head.ref})).data;
    if (branch.protected || branch.commit.sha !== pr.head.sha) { core.info('Retained protected or advanced source branch'); return; }
    await deleteBranch(full,pr.head.ref,pr.head.sha);
    core.info(`Deleted merged source branch ${pr.head.ref}`);
  }
  if (mode === 'cleanup') {
    try { await cleanup(); } catch(e) { if(e.status!==404) throw e; }
    return;
  }
  if (!eligible(pr,full) || pr.head.sha!==process.env.HEAD_SHA || pr.base.sha!==process.env.BASE_SHA) throw Error('PR head/base changed or is no longer eligible');
  if (mode === 'publish') {
    const v=verdict(process.env.REVIEW_JSON,pr.head.sha,pr.base.sha);
    const proof={head:pr.head.sha,base:pr.base.sha,verdict:v.verdict,run:c.runId};
    const body=[`${RECEIPT}${JSON.stringify(proof)} -->`,`Independent review of ${pr.head.sha} against ${pr.base.sha}.`,v.summary,...v.findings.map(f=>`[P${f.priority}] ${f.title} — ${f.path}:${f.line}\n\n${f.body}`)].join('\n\n');
    if (body.length>60000) throw Error('Review exceeds GitHub review body limit');
    await g.rest.pulls.createReview({...r,pull_number:n,commit_id:pr.head.sha,event:'COMMENT',body});
    core.setOutput('ready',String(v.verdict==='ready'));
    return;
  }
  if (mode !== 'gate') throw Error('Unknown controller mode');
  const changed=await files(n);
  if (pr.changed_files>3000 || changed.some(f=>SENSITIVE.test(f.filename) || (f.previous_filename && SENSITIVE.test(f.previous_filename)))) throw Error('Review policy changes require manual merge');
  if (process.env.CURRENT_READY !== 'true' && (await reviewEvidence(pr))?.verdict !== 'ready') { core.info('Waiting for independent review'); return; }
  if (!official(await comments(n),pr.head.sha,r.repo!=='gma3-mcp')) { core.info('Waiting for clean official code/security reviews on this head'); return; }
  // Unresolved discussions are an independent veto, even if a summary is clean.
  let cursor=null;
  do {
    const q=await g.graphql(`query($owner:String!,$repo:String!,$n:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100,after:$cursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}`,{owner:r.owner,repo:r.repo,n,cursor});
    const threads=q.repository.pullRequest.reviewThreads;
    if(threads.nodes.some(t=>!t.isResolved)) { core.info('Waiting for unresolved review discussions'); return; }
    cursor=threads.pageInfo.hasNextPage?threads.pageInfo.endCursor:null;
  } while(cursor);
  const runs=await all(g.rest.actions.listWorkflowRunsForRepo,{head_sha:pr.head.sha});
  const needed=['CI'];
  for (const name of needed) {
    const run=runs.filter(x=>x.name===name && x.event==='pull_request' && x.pull_requests.some(p=>p.number===n)).sort((a,b)=>b.id-a.id)[0];
    if(!run || run.status!=='completed' || run.conclusion!=='success') { core.info(`Waiting for successful ${name}`); return; }
    // Require CI against this current base, not just an older merge candidate.
    if(run.pull_requests.find(p=>p.number===n)?.base.sha!==pr.base.sha) { core.info('CI base is stale; rebase/rerun CI'); return; }
  }
  if (r.repo === 'gma3-mcp') {
    // Default CodeQL is a dynamic workflow named 'PR #N', not a 'CodeQL' pull_request run.
    const checks=await all(g.rest.checks.listForRef,{ref:pr.head.sha});
    const codeql=checks.filter(x=>x.name==='CodeQL' && x.app?.slug==='github-advanced-security').sort((a,b)=>b.id-a.id)[0];
    if(!codeql || codeql.status!=='completed' || codeql.conclusion!=='success') { core.info('Waiting for GitHub CodeQL'); return; }
  }
  const statuses=(await g.rest.repos.getCombinedStatusForRef({...r,ref:pr.head.sha})).data;
  if(statuses.statuses.length && statuses.state!=='success') { core.info('Commit status is pending or failing'); return; }
  if(pr.mergeable!==true || !['clean','blocked'].includes(pr.mergeable_state)) { core.info('GitHub merge state is not clean'); return; }
  pr=await getPR(n);
  if(!eligible(pr,full) || pr.head.sha!==process.env.HEAD_SHA || pr.base.sha!==process.env.BASE_SHA) throw Error('Eligibility or head/base changed before approval');
  await g.rest.pulls.createReview({...r,pull_number:n,commit_id:pr.head.sha,event:'APPROVE',body:`Accepted ${pr.head.sha} after independent and official reviews, discussions and CI passed against ${pr.base.sha}.`});
  // GITHUB_TOKEN is not an admin bypass token; GitHub still enforces branch protections.
  const merged=(await g.rest.pulls.merge({...r,pull_number:n,sha:pr.head.sha,merge_method:'squash'})).data;
  if(!merged.merged) throw Error(merged.message || 'GitHub did not merge');
  pr=await getPR(n);
  await g.rest.actions.createWorkflowDispatch({...r,workflow_id:'pr-automation.yml',ref:'main',inputs:{pr_number:''}});
  await cleanup();
}
module.exports={main,official,verdict,eligible,receipt};
