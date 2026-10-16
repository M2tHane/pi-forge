import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../../src/core/state/config.ts';
import { checkDependencies, compareVersions, inRange, PI_REQUIREMENT, playwrightSkillDir, slashPath } from '../../src/core/workspace/dependencies.ts';
import { REAL_TEMPLATE_YAML, TEST_YAML } from '../helpers/config.ts';

// web 工具组默认不分配；这里给 reviewer 加上，检查插件缺失的提醒
const config = parseConfig(TEST_YAML.replace('tools: [read, "@codegraph", forge_review_report', 'tools: [read, "@web", "@codegraph", forge_review_report'));
const probe = { codegraphVersion: () => '1.6.0' };
const pkg = (root: string, name: string, version: string) => {
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, version }));
};
const by = (items: ReturnType<typeof checkDependencies>, item: string) => items.find((i) => i.item === item)!;

test('版本比较与验证区间', () => {
  assert.ok(compareVersions('1.0.0', '0.99.2') > 0);
  assert.ok(compareVersions('0.99.0', '0.99.0') === 0);
  assert.ok(inRange('1.0.0', PI_REQUIREMENT.tested));
  assert.ok(inRange('0.99.2', PI_REQUIREMENT.tested));
  assert.ok(!inRange('2.0.0', PI_REQUIREMENT.tested));
});

test('依赖检查：Pi 过低报错、超出验证范围提醒；插件按角色是否用到检查，缺失给安装命令与链接；版本不符提醒', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-deps-'));
  try {
    const root = path.join(dir, 'nm');
    pkg(root, '@vndv/pi-codegraph', '0.3.0');
    const items = checkDependencies({ config, piVersion: '1.0.0', packageRoots: [root], probe });
    assert.equal(by(items, 'Pi').level, 'ok');
    const cg = by(items, '@vndv/pi-codegraph');
    assert.equal(cg.level, 'warn');
    assert.match(cg.detail, /0\.3\.0 未经验证.*pi install npm:@vndv\/pi-codegraph@0\.1\.10/);
    const web = by(items, 'pi-web-access');
    assert.equal(web.level, 'warn');
    assert.match(web.detail, /未安装：reviewer .*pi install npm:pi-web-access.*https:\/\/github\.com\/nicobailon\/pi-web-access/);
    assert.equal(by(items, 'codegraph').level, 'ok');

    assert.equal(by(checkDependencies({ config, piVersion: '0.98.0', packageRoots: [root], probe }), 'Pi').level, 'error');
    assert.match(by(checkDependencies({ config, piVersion: '2.1.0', packageRoots: [root], probe }), 'Pi').detail, /未经验证/);
    // 没有角色用到的插件不检查
    const noWeb = parseConfig(TEST_YAML);
    assert.equal(checkDependencies({ config: noWeb, packageRoots: [root], probe }).find((i) => i.item === 'pi-web-access'), undefined);
    // 主 agent 的选择题提问插件：模板里 orchestrator 用到，没装时提醒（不影响开始）
    const ask = by(checkDependencies({ config: parseConfig(REAL_TEMPLATE_YAML), packageRoots: [root], probe }), '@tian.zuo/pi-ask-user');
    assert.equal(ask.level, 'warn');
    assert.match(ask.detail, /未安装：orchestrator .*pi install npm:@tian\.zuo\/pi-ask-user/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('浏览器检查技能 pi-playwright：没装不能开始，给出两条三个系统都能运行的命令；项目级或用户级安装都算；技能目录用正斜杠', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-forge-deps-'));
  try {
    const [proj, user] = [path.join(dir, 'proj'), path.join(dir, 'user')];
    const missing = by(checkDependencies({ config, packageRoots: [proj, user], probe }), 'pi-playwright');
    assert.equal(missing.level, 'error');
    assert.ok(missing.detail.includes(`pi install npm:pi-playwright，然后 npm --prefix "${slashPath(path.join(user, 'pi-playwright'))}" run setup`), missing.detail);
    assert.doesNotMatch(missing.detail, /&&|\bcd\b|~/);
    assert.equal(playwrightSkillDir([proj, user]), null);
    pkg(proj, 'pi-playwright', '0.1.2');
    assert.equal(by(checkDependencies({ config, packageRoots: [proj, user], probe }), 'pi-playwright').level, 'ok');
    assert.equal(playwrightSkillDir([proj, user]), slashPath(path.join(proj, 'pi-playwright', 'skills', 'playwright-browser')));
    assert.equal(checkDependencies({ config, probe }).find((i) => i.item === 'pi-playwright'), undefined, '不提供安装位置时不检查');
    assert.equal(slashPath('C:\\Users\\x\\.pi\\agent\\npm\\node_modules\\pi-playwright'), 'C:/Users/x/.pi/agent/npm/node_modules/pi-playwright');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
