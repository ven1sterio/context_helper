const {parseGraph}=require('../out/graphStore.js');
const {selectWithGraph}=require('../out/graphSelector.js');
const known=new Set(['src/timeouts.ts','src/wsServer.ts','src/taskRunner.ts','src/contextManager.ts','browser-extension/content.js','browser-extension/providers/gemini.js','src/other.ts']);
const raw={nodes:[
 {id:'a',label:'humanDelay',source_file:'browser-extension/content.js',community:0},
 {id:'b',label:'waitBetweenResends',source_file:'C:\\proj\\browser-extension\\content.js:90',community:0},
 {id:'c',label:'GeminiProvider',source_file:'./browser-extension/providers/gemini.js',community:1},
 {id:'d',label:'getTimeouts',source_file:'src/timeouts.ts',community:2},
 {id:'e',label:'TaskRunner',source_file:'src/taskRunner.ts',community:2},
 {id:'f',label:'Orphan',source_file:'nao/existe.ts',community:3},
 {id:'g',label:'ContextManager',source_file:'src/contextManager.ts',community:4}],
 links:[{source:'a',target:'d',relation:'calls',confidence:'EXTRACTED'},
        {source:'d',target:'e',relation:'imports',confidence:'INFERRED'},
        {source:{id:'g'},target:'c',relation:'mentions',confidence:0.5}]};
const g=parseGraph(raw,'C:\\proj',known);
console.log('nodes',g.nodes.size,'files',[...g.byFile.keys()],'unmapped',g.unmapped);
const r=selectWithGraph('o delay do cooldown no content',g,[{path:'src/other.ts',score:3,reasons:['conteúdo:delay']}]);
console.log(r.usedGraph,r.seeds);r.files.forEach(f=>console.log(f.score.toFixed(1),f.path,f.reasons.join(' | ')));
