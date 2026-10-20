import {describe,expect,test} from 'bun:test'
import {REVIEW_C0_SCHEMA_VERSION,type CanonicalPlan,type RuleSpec} from '@profer/shared'
import {
  compileT04Operation, conditionT04, decimalT04, evaluateT04Plan,
  evaluateT04Rule, formatT04, resolveT04PolicyClaims,
  toT04CheckResult, type T04Item, type T04Operation,
} from './review-v3-t04-rules-scoring'

const makeRule = (id:string, patch:Partial<RuleSpec>={}):RuleSpec=>({
  id,policyVersionId:'p@1',title:id,when:{all:[]},requirement:id,
  targetScope:'group',execution:'deterministic',onFail:'manual-review',
  onUnknown:'needs-confirmation',sourceRefIds:['policy-source-v1'],
  priority:1,confirmation:'confirmed',...patch,
})
const item = (id:string, fields:Record<string,string|number|boolean|null>, unknown:string[]=[]):T04Item=>({
  id,fields:Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value,confirmed:!unknown.includes(key)}])),
})

describe('T04 real deterministic calculations (D04-D07)',()=>{
  test('D04: same E1 6/3 picks 6; E2 5, cap 10 allocates 6+4; rerun identical',()=>{
    const rule=makeRule('d04')
    const op:T04Operation={kind:'group-score',calculation:{
      valueFrom:'score',deduplicateBy:['event'],select:'highest-eligible-score',
      aggregate:'sum',cap:{value:'10.00',unit:'point'},allocation:'score-desc-then-subject-id',
    }}
    const rows=[item('s1',{score:6,event:'E1'}),item('s2',{score:3,event:'E1'}),item('s3',{score:5,event:'E2'})]
    const result=evaluateT04Rule(rule,op,rows)
    expect(result.status).toBe('compliant')
    expect(result.result).toBe('10.00')
    expect(Object.fromEntries(result.allocation!.map(x=>[x.itemId,x.counted]))).toEqual({s1:'6.00',s2:'0.00',s3:'4.00'})
    expect(evaluateT04Rule(rule,op,rows)).toEqual(result)
    expect(evaluateT04Rule(rule,op,[rows[0]!,item('s4',{score:0,event:null},['event'])]).status).toBe('awaiting-confirmation')
  })
  test('D05: weighted 85/90/95/80 = 87.75; explicit zero works, missing is not zero',()=>{
    const op:T04Operation={kind:'weighted-sum',terms:[
      {field:'study',weight:'0.50'},{field:'moral',weight:'0.30'},
      {field:'bonus',weight:'0.15'},{field:'sports',weight:'0.05'},
    ]}
    const rule=makeRule('weighted')
    const fields={study:85,moral:90,bonus:95,sports:80}
    expect(evaluateT04Rule(rule,op,[item('a',fields)]).result).toBe('87.75')
    expect(evaluateT04Rule(rule,op,[item('a',{...fields,bonus:0})]).result).toBe('73.50')
    const unknown=evaluateT04Rule(rule,op,[item('a',fields,['sports'])])
    expect(unknown.status).toBe('awaiting-confirmation')
    expect(unknown.result).toBeNull()
  })
  test('D06: exact decimals, cap and unknown currency never folded into approved result',()=>{
    const op:T04Operation={kind:'amount-cap',amountField:'amount',currencyField:'currency',cap:'180.00',currency:'CNY'}
    const rule=makeRule('expense')
    const known=[item('a',{amount:'123.45',currency:'CNY'}),item('b',{amount:'76.55',currency:'CNY'})]
    const complete=evaluateT04Rule(rule,op,known)
    expect(complete.result).toBe('180.00')
    expect(complete.knownSubtotal).toBe('200.00')
    expect(complete.excess).toBe('20.00')
    const partial=evaluateT04Rule(rule,op,[...known,item('c',{amount:'25',currency:null},['currency'])])
    expect(partial.status).toBe('awaiting-confirmation')
    expect(partial.result).toBeNull()
    expect(partial.knownSubtotal).toBe('200.00')
    expect(decimalT04('0.1')+decimalT04('0.2')).toBe(decimalT04('0.3'))
    expect(formatT04(decimalT04('2.345'),2)).toBe('2.35')
  })
  test('D07: inclusive pure-date boundaries; unknown timezone/date stays pending',()=>{
    const op:T04Operation={kind:'date-range',field:'date',from:'2025-01-01',until:'2025-12-31'}
    const rule=makeRule('dates')
    expect(evaluateT04Rule(rule,op,[item('first',{date:'2025-01-01'}),item('last',{date:'2025-12-31'})]).status).toBe('compliant')
    expect(evaluateT04Rule(rule,op,[item('before',{date:'2024-12-31'})]).status).toBe('non-compliant')
    expect(evaluateT04Rule(rule,op,[item('after',{date:'2026-01-01'})]).status).toBe('non-compliant')
    expect(evaluateT04Rule(rule,op,[item('bad',{date:'2025-02-30'})]).status).toBe('awaiting-confirmation')
    expect(evaluateT04Rule(rule,op,[item('zoned',{date:'2025-04-01T00:00:00+08:00'})]).status).toBe('awaiting-confirmation')
  })
  test('conditions: all/any/not and exceptions are three-valued, not a silent pass',()=>{
    const row=item('x',{category:'competition',approved:0})
    expect(conditionT04({all:[{field:'category',op:'eq',value:'competition'},{not:{field:'approved',op:'eq',value:1}}]},row)).toBe('true')
    expect(conditionT04({any:[{field:'missing',op:'exists'},{field:'approved',op:'eq',value:1}]},row)).toBe('unknown')
    const rule=makeRule('except',{exceptions:[{when:{field:'waiver',op:'eq',value:'yes'},note:'special'}]})
    expect(evaluateT04Rule(rule,{kind:'value-limit',field:'approved',maximum:'1'},[row]).status).toBe('awaiting-confirmation')
  })
})
describe('T04 multi-policy and Plan adapter (D09)',()=>{
  const a=makeRule('a',{policyVersionId:'school@1'}),b=makeRule('b',{policyVersionId:'faculty@1'})
  const cap=(v:string):T04Operation=>({kind:'group-score',calculation:{valueFrom:'score',aggregate:'sum',cap:{value:v,unit:'point'}}})
  test('two enabled conflicting caps block only their claim; explicit named decision chooses one',()=>{
    const claims=[{key:'competition-cap',rule:a,operation:cap('10')},{key:'competition-cap',rule:b,operation:cap('12')},
      {key:'date-rule',rule:makeRule('date'),operation:{kind:'date-range' as const,field:'date'}}]
    expect(resolveT04PolicyClaims(claims).blocked[0]?.ruleIds).toEqual(['a','b'])
    expect(resolveT04PolicyClaims(claims).selected.map(x=>x.rule.id)).toEqual(['date'])
    const resolved=resolveT04PolicyClaims(claims,[{key:'competition-cap',selectedRuleId:'a',confirmedBy:'local-reviewer',reason:'确定学校政策优先'}])
    expect(resolved.blocked).toHaveLength(0)
    expect(resolved.selected.map(x=>x.rule.id)).toEqual(['a','date'])
    expect(resolved.excluded[0]?.ruleId).toBe('b')
  })
  test('Plan with repeated checkKey across targets evaluates each exact target independently',()=>{
    const bindings=[
      {checkKey:'cap',targetKey:'subject:x',objectKey:'o:x',subjectId:'x',sourceVersionIds:['policy-v1'],applicability:'applicable' as const,conditionFingerprint:'c'},
      {checkKey:'cap',targetKey:'subject:y',objectKey:'o:y',subjectId:'y',sourceVersionIds:['policy-v1'],applicability:'applicable' as const,conditionFingerprint:'c'},
    ]
    const plan:CanonicalPlan={schemaVersion:REVIEW_C0_SCHEMA_VERSION,planId:'p',fingerprint:'f',templateId:'t',templateVersion:'1',moduleDigests:[],bindings}
    const op:T04Operation={kind:'value-limit',field:'score',maximum:'10'}
    const result=evaluateT04Plan(plan,bindings.map((binding,i)=>({binding,rule:a,operation:op,items:[item(i?'y':'x',{score:i?12:8})]})))
    expect(result.map(x=>x.outcome.status)).toEqual(['compliant','non-compliant'])
    expect(result[0]?.checkKey).toBe('cap')
    expect(toT04CheckResult(result[0]!,{scope:'subject',subjectIds:['x']},[],'2026-10-21T00:00:00Z').executedBy).toBe('deterministic')
  })
  test('confirmed fixed score checks equality, not only a less-than upper bound',()=>{
    const rule=makeRule('score',{workspaceConstraint:{kind:'score-value',value:4,appliesWhen:{field:'category',equals:'contest'}}})
    const operation=compileT04Operation(rule)
    expect(evaluateT04Rule(rule,operation,[item('x',{declaredScore:3})]).status).toBe('non-compliant')
    expect(evaluateT04Rule(rule,operation,[item('x',{declaredScore:4})]).status).toBe('compliant')
  })
})
