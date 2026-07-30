const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const scriptsJs = fs.readFileSync(path.join(root, 'frontend', 'scripts.js'), 'utf8');

assert(!indexHtml.includes('竞研 <br>'), 'landing title should keep 竞研 and Agent on one line');
assert(indexHtml.includes('竞研 <span'), 'landing title should render 竞研 and Agent inline');
assert(!indexHtml.includes('中文报告'), 'landing copy should say 报告, not 中文报告');
assert(!indexHtml.includes('<a href="#form" class="btn btn-primary">开始研究</a>'), 'landing CTA should be removed');

assert(!indexHtml.includes('id="report_type"'), 'visible report type selector should be removed');
assert(!indexHtml.includes('id="tone"'), 'visible tone selector should be removed');
assert(indexHtml.includes('id="report_source"'), 'research source selector should remain visible');
assert(indexHtml.includes('id="maxSearchResults"'), 'max search results input should remain visible');
assert(indexHtml.includes('id="queryDomains"'), 'query domains input should remain visible');

assert(scriptsJs.includes('const report_type = "research_report"'), 'frontend should submit fixed research_report payload');
assert(scriptsJs.includes('const tone = "Objective"'), 'frontend should submit fixed Objective tone payload');
assert(!scriptsJs.includes('select[name="report_type"]'), 'scripts should not depend on removed report type select');
assert(!scriptsJs.includes('select[name="tone"]'), 'scripts should not depend on removed tone select');
assert(scriptsJs.includes('select[name="report_source"]'), 'scripts should still read report source');
assert(scriptsJs.includes('max_search_results: parseInt(document.getElementById(\'maxSearchResults\').value, 10) || 5'), 'scripts should still send max search results');
assert(scriptsJs.includes('input[name="query_domains"]'), 'scripts should still send query domains');

console.log('workbench_layout_check passed');
