# -*- coding: utf-8 -*-
"""AI小说工坊 - 打包产物诊断脚本
双击 check_build.bat 运行（或 python check_build.py）。
用于排查：安装后启动报「内置服务进程异常退出」「页面空白」等问题。
"""
import os
import sys
import json

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
FOUND_ISSUE = False


def ok(msg):
    print('[OK] ' + msg)


def warn(msg):
    global FOUND_ISSUE
    FOUND_ISSUE = True
    print('[!!] ' + msg)


def hr():
    print('-' * 60)


def main():
    print('=' * 60)
    print('  AI小说工坊 打包产物诊断')
    print('=' * 60)

    # 1. 检查打包配置 extraResources 是否含 node_modules 独立条目
    print('\n[1] 检查 desktop/package.json 打包配置')
    pkg = os.path.join(ROOT, 'desktop', 'package.json')
    if not os.path.exists(pkg):
        warn('找不到 desktop/package.json，请确认脚本放在项目根目录')
    else:
        with open(pkg, encoding='utf-8') as f:
            cfg = json.load(f)
        er = (cfg.get('build', {}) or {}).get('extraResources', []) or []
        has_nm = any('node_modules' in str(item) for item in er)
        has_wd = any('web/dist' in str(item) or 'dist' in str(item) for item in er)
        if has_nm:
            ok('extraResources 已单独复制 server/node_modules')
        else:
            warn('extraResources 中没有独立复制 server/node_modules 的条目！')
            warn('这会导致打包后后端缺少依赖，启动即退出（需更新 desktop/package.json）')
        if has_wd:
            ok('extraResources 包含前端产物 web/dist')
        else:
            warn('extraResources 缺少 web/dist，前端页面会无法加载')

    # 2. 定位打包产物里的 resources/server
    print('\n[2] 查找打包后的 resources/server')
    candidates = []
    # 项目内 win-unpacked
    unpacked = os.path.join(ROOT, 'desktop', 'release', 'win-unpacked', 'resources', 'server')
    candidates.append(('项目内 desktop/release/win-unpacked', unpacked))
    # 常见安装目录
    for pf in ('C:\\Program Files\\AI小说工坊', 'D:\\AI小说工坊', 'E:\\AI小说工坊'):
        candidates.append(('安装目录 ' + pf, os.path.join(pf, 'resources', 'server')))

    server_dir = None
    for label, p in candidates:
        if os.path.isdir(p):
            server_dir = p
            ok('找到打包产物: %s (%s)' % (label, p))
            break
    if server_dir is None:
        warn('未在常见位置找到打包产物，请手动把 server 目录路径发我')
        server_dir = os.path.join(unpacked)

    # 3. 检查后端依赖完整性
    print('\n[3] 检查后端依赖 (resources/server/node_modules)')
    nm = os.path.join(server_dir, 'node_modules')
    if not os.path.isdir(nm):
        warn('resources/server/node_modules 不存在！后端无法启动（这就是异常退出的原因）')
    else:
        pkgs = [d for d in os.listdir(nm) if not d.startswith('.')]
        print('    依赖包数量: %d' % len(pkgs))
        for key in ('express', 'cors'):
            if os.path.isdir(os.path.join(nm, key)):
                ok('关键依赖 %s 存在' % key)
            else:
                warn('关键依赖 %s 缺失！' % key)
        if len(pkgs) < 50:
            warn('依赖包数量偏少(%d)，可能有包未复制完整' % len(pkgs))

    # 4. 检查前端产物
    print('\n[4] 检查前端产物 (resources/web/dist)')
    dist = os.path.join(os.path.dirname(server_dir), 'web', 'dist')
    if os.path.isfile(os.path.join(dist, 'index.html')):
        ok('前端页面 index.html 存在')
    else:
        warn('resources/web/dist/index.html 不存在，页面会空白')
        warn('（注意：需要先把 web 目录构建一次，npm run build 生成 dist）')

    # 5. 读取后端日志
    print('\n[5] 读取后端日志 server.log')
    apdata = os.environ.get('APPDATA', '')
    log = os.path.join(apdata, 'AI小说工坊', 'server.log')
    if not os.path.exists(log):
        warn('未找到 server.log（%s）' % log)
        warn('如果应用从未成功启动过后端，日志不会生成；先更新代码重新打包再测试')
    else:
        ok('找到 server.log')
        with open(log, encoding='utf-8', errors='replace') as f:
            lines = f.read().splitlines()
        print('    日志最后 40 行：')
        hr()
        for line in lines[-40:]:
            print('    ' + line)
        hr()

    print('\n' + '=' * 60)
    if FOUND_ISSUE:
        print('  发现问题：请把本窗口完整内容复制发给我')
    else:
        print('  未发现明显问题。若仍启动失败，请把 server.log 内容发给我')
    print('=' * 60)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('脚本执行出错: %r' % e)
        print('请把本窗口内容复制发给我')
    input('\n按回车键退出...')
