// 检查 Node.js 版本是否满足要求（>= 22.13），供一键启动脚本调用
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 13)) process.exit(0);
console.log(`当前 Node.js 版本是 ${process.versions.node}，需要 22.13 或更高版本。`);
process.exit(1);
