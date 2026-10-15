import type { AttachedDirectoryProjectCandidate } from './attached-directory-project-detector'

function escapePromptXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Pi 没有 Claude SDK 的 additionalDirectories 原生访问说明，需显式注入授权路径与识别出的项目候选。 */
export function buildPiAdditionalDirectoriesPrompt(
  directories: string[],
  projectCandidates: AttachedDirectoryProjectCandidate[] = [],
): string {
  if (directories.length === 0) return ''
  const directoryLines = directories
    .map((dir, index) => `  <directory index="${index + 1}">${escapePromptXml(dir)}</directory>`)
    .join('\n')
  const projectCandidatesBlock = projectCandidates.length === 0
    ? ''
    : `

<detected_project_candidates>
${projectCandidates.map((candidate) => `  <project>
    <root>${escapePromptXml(candidate.rootPath)}</root>
    <name>${escapePromptXml(candidate.name)}</name>
    <type>${escapePromptXml(candidate.type)}</type>
    <relative_to_attached_directory>${escapePromptXml(candidate.relativePath)}</relative_to_attached_directory>
    <evidence>${escapePromptXml(candidate.evidence.join(', '))}</evidence>
    ${candidate.packageName ? `<package_name>${escapePromptXml(candidate.packageName)}</package_name>\n    ` : ''}${candidate.gitRemote ? `<git_remote>${escapePromptXml(candidate.gitRemote)}</git_remote>\n    ` : ''}${candidate.repositoryRoot ? `<repository_root>${escapePromptXml(candidate.repositoryRoot)}</repository_root>\n    ` : ''}<source_attached_directory>${escapePromptXml(candidate.sourceDirectory)}</source_attached_directory>
  </project>`).join('\n')}
</detected_project_candidates>

When the user refers to context like "repo, repository, project, Vault, Obsidian, note library, here"（repo、仓库、项目、Vault、Obsidian、笔记库、这里）, you must first check the project candidates above:
1. root is the actual absolute path to read or operate on; never substitute source_attached_directory, the current cwd, or another candidate's path for it.
2. Prefer disambiguating by the project name, directory name, package_name, git_remote, project type, and repository_root the user explicitly mentioned; repository_root only indicates the repository a sub-project belongs to and never means the sub-project's own root should be ignored.
3. Use a candidate's root directly only when there is a unique semantic match; ask the user for the path only when there is no match or multiple candidates remain. Never ignore candidates inside the authorized additional directories just because the current cwd contains no project.`

  return `

<attached_directories>
These directories have been authorized to the current session by Profer and, together with the current working directory, belong to the user-permitted access scope.
To read or modify content inside them, use absolute paths directly; do not copy them into the current working directory first.
${directoryLines}
</attached_directories>${projectCandidatesBlock}`
}
