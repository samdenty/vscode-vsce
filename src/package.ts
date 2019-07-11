import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as _ from 'lodash';
import * as yazl from 'yazl';
import { Manifest } from './manifest';
import { ITranslations, patchNLS } from './nls';
import * as util from './util';
import * as _glob from 'glob';
import * as minimatch from 'minimatch';
import * as denodeify from 'denodeify';
import * as markdownit from 'markdown-it';
import * as cheerio from 'cheerio';
import * as url from 'url';
import { lookup } from 'mime';
import * as urljoin from 'url-join';
import { validatePublisher, validateExtensionName, validateVersion, validateEngineCompatibility, validateVSCodeTypesCompatibility } from './validation';
import { getDependencies } from './npm';

interface IReadFile {
	(filePath: string): Promise<Buffer>;
	(filePath: string, encoding?: string): Promise<string>;
}

const readFile = denodeify<string, string, string>(fs.readFile);
const unlink = denodeify<string, void>(fs.unlink as any);
const stat = denodeify(fs.stat);
const exec = denodeify<string, { cwd?: string; env?: any; maxBuffer?: number; }, { stdout: string; stderr: string; }>(cp.exec as any, (err, stdout, stderr) => [err, { stdout, stderr }]);
const glob = denodeify<string, _glob.IOptions, string[]>(_glob);

const resourcesPath = path.join(path.dirname(__dirname), 'resources');
const vsixManifestTemplatePath = path.join(resourcesPath, 'extension.vsixmanifest');
const contentTypesTemplatePath = path.join(resourcesPath, '[Content_Types].xml');

const MinimatchOptions: minimatch.IOptions = { dot: true };

export interface IFile {
	path: string;
	contents?: Buffer | string;
	localPath?: string;
}

export function read(file: IFile): Promise<string> {
	if (file.contents) {
		return Promise.resolve(file.contents).then(b => typeof b === 'string' ? b : b.toString('utf8'));
	} else {
		return readFile(file.localPath, 'utf8');
	}
}

export interface IPackage {
	manifest: Manifest;
	packagePath: string;
}

export interface IPackageResult extends IPackage {
	files: IFile[];
}

export interface IAsset {
	type: string;
	path: string;
}

export interface IPackageOptions {
	cwd?: string;
	packagePath?: string;
	baseContentUrl?: string;
	baseImagesUrl?: string;
	useYarn?: boolean;
	dependencyEntryPoints?: string[];
}

export interface IProcessor {
	onFile(file: IFile): Promise<IFile>;
	onEnd(): Promise<void>;
	assets: IAsset[];
	vsix: any;
}

export class BaseProcessor implements IProcessor {
	constructor(protected manifest: Manifest) { }
	assets: IAsset[] = [];
	vsix: any = Object.create(null);
	onFile(file: IFile): Promise<IFile> { return Promise.resolve(file); }
	onEnd() { return Promise.resolve(null); }
}

function getUrl(url: string | { url?: string; }): string {
	if (!url) {
		return null;
	}

	if (typeof url === 'string') {
		return <string>url;
	}

	return (<any>url).url;
}

function getRepositoryUrl(url: string | { url?: string; }): string {
	const result = getUrl(url);

	if (/^[^\/]+\/[^\/]+$/.test(result)) {
		return `https://github.com/${result}.git`;
	}

	return result;
}

// Contributed by Mozilla develpoer authors
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
function escapeRegExp(string) {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

function toExtensionTags(extensions: string[]): string[] {
	return extensions
		.map(s => s.replace(/\W/g, ''))
		.filter(s => !!s)
		.map(s => `__ext_${s}`);
}

function toLanguagePackTags(translations: { id: string }[], languageId: string): string[] {
	return (translations || [])
		.map(({ id }) => [`__lp_${id}`, `__lp-${languageId}_${id}`])
		.reduce((r, t) => [...r, ...t], []);
}

/* This list is also maintained by the Marketplace team.
 * Remember to reach out to them when adding new domains.
 */
const TrustedSVGSources = [
	'api.bintray.com',
	'api.travis-ci.com',
	'api.travis-ci.org',
	'app.fossa.io',
	'badge.buildkite.com',
	'badge.fury.io',
	'badge.waffle.io',
	'badgen.net',
	'badges.frapsoft.com',
	'badges.gitter.im',
	'badges.greenkeeper.io',
	'cdn.travis-ci.com',
	'cdn.travis-ci.org',
	'ci.appveyor.com',
	'circleci.com',
	'cla.opensource.microsoft.com',
	'codacy.com',
	'codeclimate.com',
	'codecov.io',
	'coveralls.io',
	'david-dm.org',
	'deepscan.io',
	'dev.azure.com',
	'docs.rs',
	'flat.badgen.net',
	'gemnasium.com',
	'githost.io',
	'gitlab.com',
	'godoc.org',
	'goreportcard.com',
	'img.shields.io',
	'isitmaintained.com',
	'marketplace.visualstudio.com',
	'nodesecurity.io',
	'opencollective.com',
	'snyk.io',
	'travis-ci.com',
	'travis-ci.org',
	'visualstudio.com',
	'vsmarketplacebadge.apphb.com',
	'www.bithound.io',
	'www.versioneye.com'
];

function isHostTrusted(host: string): boolean {
	return TrustedSVGSources.indexOf(host.toLowerCase()) > -1;
}

function isGitHubRepository(repository: string): boolean {
	return /^https:\/\/github\.com\/|^git@github\.com:/.test(repository || '');
}

class ManifestProcessor extends BaseProcessor {

	constructor(manifest: Manifest) {
		super(manifest);

		const flags = ['Public'];

		if (manifest.preview) {
			flags.push('Preview');
		}

		const repository = getRepositoryUrl(manifest.repository);
		const isGitHub = isGitHubRepository(repository);

		let enableMarketplaceQnA: boolean | undefined;
		let customerQnALink: string | undefined;

		if (manifest.qna === 'marketplace') {
			enableMarketplaceQnA = true;
		} else if (typeof manifest.qna === 'string') {
			customerQnALink = manifest.qna;
		} else if (manifest.qna === false) {
			enableMarketplaceQnA = false;
		}

		this.vsix = {
			...this.vsix,
			id: manifest.name,
			displayName: manifest.displayName || manifest.name,
			version: manifest.version,
			publisher: manifest.publisher,
			engine: manifest.engines['vscode'],
			description: manifest.description || '',
			categories: (manifest.categories || []).join(','),
			flags: flags.join(' '),
			links: {
				repository,
				bugs: getUrl(manifest.bugs),
				homepage: manifest.homepage
			},
			galleryBanner: manifest.galleryBanner || {},
			badges: manifest.badges,
			githubMarkdown: manifest.markdown !== 'standard',
			enableMarketplaceQnA,
			customerQnALink,
			extensionDependencies: _(manifest.extensionDependencies || []).uniq().join(','),
			extensionPack: _(manifest.extensionPack || []).uniq().join(','),
			localizedLanguages: (manifest.contributes && manifest.contributes.localizations) ?
				manifest.contributes.localizations.map(loc => loc.localizedLanguageName || loc.languageName || loc.languageId).join(',') : ''
		};

		if (isGitHub) {
			this.vsix.links.github = repository;
		}
	}

	async onEnd(): Promise<void> {
		if (this.manifest.publisher === 'vscode-samples') {
			throw new Error('It\'s not allowed to use the \'vscode-samples\' publisher. Learn more at: https://code.visualstudio.com/api/working-with-extensions/publishing-extension.');
		}

		if (!this.manifest.repository) {
			util.log.warn(`A 'repository' field is missing from the 'package.json' manifest file.`);

			if (!/^y$/i.test(await util.read('Do you want to continue? [y/N] '))) {
				throw new Error('Aborted');
			}
		}
	}
}

export class TagsProcessor extends BaseProcessor {

	private static Keywords = {
		'git': ['git'],
		'npm': ['node'],
		'spell': ['markdown'],
		'bootstrap': ['bootstrap'],
		'lint': ['linters'],
		'linting': ['linters'],
		'react': ['javascript'],
		'js': ['javascript'],
		'node': ['javascript', 'node'],
		'c++': ['c++'],
		'Cplusplus': ['c++'],
		'xml': ['xml'],
		'angular': ['javascript'],
		'jquery': ['javascript'],
		'php': ['php'],
		'python': ['python'],
		'latex': ['latex'],
		'ruby': ['ruby'],
		'java': ['java'],
		'erlang': ['erlang'],
		'sql': ['sql'],
		'nodejs': ['node'],
		'c#': ['c#'],
		'css': ['css'],
		'javascript': ['javascript'],
		'ftp': ['ftp'],
		'haskell': ['haskell'],
		'unity': ['unity'],
		'terminal': ['terminal'],
		'powershell': ['powershell'],
		'laravel': ['laravel'],
		'meteor': ['meteor'],
		'emmet': ['emmet'],
		'eslint': ['linters'],
		'tfs': ['tfs'],
		'rust': ['rust']
	};

	onEnd(): Promise<void> {
		const keywords = this.manifest.keywords || [];
		const contributes = this.manifest.contributes;
		const activationEvents = this.manifest.activationEvents || [];
		const doesContribute = name => contributes && contributes[name] && contributes[name].length > 0;

		const colorThemes = doesContribute('themes') ? ['theme', 'color-theme'] : [];
		const iconThemes = doesContribute('iconThemes') ? ['theme', 'icon-theme'] : [];
		const snippets = doesContribute('snippets') ? ['snippet'] : [];
		const keybindings = doesContribute('keybindings') ? ['keybindings'] : [];
		const debuggers = doesContribute('debuggers') ? ['debuggers'] : [];
		const json = doesContribute('jsonValidation') ? ['json'] : [];

		const localizationContributions = ((contributes && contributes['localizations']) || [])
			.reduce((r, l) => [...r, `lp-${l.languageId}`, ...toLanguagePackTags(l.translations, l.languageId)], []);

		const languageContributions = ((contributes && contributes['languages']) || [])
			.reduce((r, l) => [...r, l.id, ...(l.aliases || []), ...toExtensionTags(l.extensions || [])], []);

		const languageActivations = activationEvents
			.map(e => /^onLanguage:(.*)$/.exec(e))
			.filter(r => !!r)
			.map(r => r[1]);

		const grammars = ((contributes && contributes['grammars']) || [])
			.map(g => g.language);

		const description = this.manifest.description || '';
		const descriptionKeywords = Object.keys(TagsProcessor.Keywords)
			.reduce((r, k) => r.concat(new RegExp('\\b(?:' + escapeRegExp(k) + ')(?!\\w)', 'gi').test(description) ? TagsProcessor.Keywords[k] : []), []);

		const tags = [
			...keywords,
			...colorThemes,
			...iconThemes,
			...snippets,
			...keybindings,
			...debuggers,
			...json,
			...localizationContributions,
			...languageContributions,
			...languageActivations,
			...grammars,
			...descriptionKeywords
		];

		this.vsix.tags = _(tags)
			.uniq() // deduplicate
			.compact() // remove falsey values
			.join(',');

		return Promise.resolve(null);
	}
}

export class MarkdownProcessor extends BaseProcessor {

	private baseContentUrl: string;
	private baseImagesUrl: string;
	private isGitHub: boolean;
	private repositoryUrl: string;

	constructor(manifest: Manifest, private name: string, private regexp: RegExp, private assetType: string, options: IPackageOptions = {}) {
		super(manifest);

		const guess = this.guessBaseUrls();

		this.baseContentUrl = options.baseContentUrl || (guess && guess.content);
		this.baseImagesUrl = options.baseImagesUrl || options.baseContentUrl || (guess && guess.images);
		this.repositoryUrl = (guess && guess.repository);
		this.isGitHub = isGitHubRepository(this.repositoryUrl);
	}

	async onFile(file: IFile): Promise<IFile> {
		const path = util.normalize(file.path);

		if (!this.regexp.test(path)) {
			return Promise.resolve(file);
		}

		this.assets.push({ type: this.assetType, path });

		let contents = await read(file);

		if (/This is the README for your extension /.test(contents)) {
			throw new Error(`Make sure to edit the README.md file before you publish your extension.`);
		}

		const markdownPathRegex = /(!?)\[([^\]\[]*|!\[[^\]\[]*]\([^\)]+\))\]\(([^\)]+)\)/g;
		const urlReplace = (all, isImage, title, link) => {
			const isLinkRelative = !/^\w+:\/\//.test(link) && link[0] !== '#';

			if (!this.baseContentUrl && !this.baseImagesUrl) {
				const asset = isImage ? 'image' : 'link';

				if (isLinkRelative) {
					throw new Error(`Couldn't detect the repository where this extension is published. The ${asset} '${link}' will be broken in ${this.name}. Please provide the repository URL in package.json or use the --baseContentUrl and --baseImagesUrl options.`);
				}
			}

			title = title.replace(markdownPathRegex, urlReplace);
			const prefix = isImage ? this.baseImagesUrl : this.baseContentUrl;

			if (!prefix || !isLinkRelative) {
				return `${isImage}[${title}](${link})`;
			}

			return `${isImage}[${title}](${urljoin(prefix, link)})`;
		};
		// Replace Markdown links with urls
		contents = contents.replace(markdownPathRegex, urlReplace);

		const markdownIssueRegex = /(\s|\n)([\w\d_-]+\/[\w\d_-]+)?#(\d+)\b/g
		const issueReplace = (all: string, prefix: string, ownerAndRepositoryName: string, issueNumber: string): string => {
			let result = all;
			let owner: string;
			let repositoryName: string;

			if (ownerAndRepositoryName) {
				[owner, repositoryName] = ownerAndRepositoryName.split('/', 2);
			}

			if (this.isGitHub){
				if (owner && repositoryName && issueNumber) {
					 // Issue in external repository
					const issueUrl = urljoin('https://github.com', owner, repositoryName, 'issues', issueNumber);
					result = prefix + `[${owner}/${repositoryName}#${issueNumber}](${issueUrl})`;

				} else if (!owner && !repositoryName && issueNumber) {
					// Issue in own repository
					result = prefix + `[#${issueNumber}](${urljoin(this.repositoryUrl, 'issues', issueNumber)})`;
				}
			}

			return result;
		}
		// Replace Markdown issue references with urls
		contents = contents.replace(markdownIssueRegex, issueReplace);

		const html = markdownit({ html: true }).render(contents);
		const $ = cheerio.load(html);

		$('img').each((_, img) => {
			const src = decodeURI(img.attribs.src);
			const srcUrl = url.parse(src);

			if (/^data:$/i.test(srcUrl.protocol) && /^image$/i.test(srcUrl.host) && /\/svg/i.test(srcUrl.path)) {
				throw new Error(`SVG data URLs are not allowed in ${this.name}: ${src}`);
			}

			if (!/^https:$/i.test(srcUrl.protocol)) {
				throw new Error(`Images in ${this.name} must come from an HTTPS source: ${src}`);
			}

			if (/\.svg$/i.test(srcUrl.pathname) && !isHostTrusted(srcUrl.host)) {
				throw new Error(`SVGs are restricted in ${this.name}; please use other file image formats, such as PNG: ${src}`);
			}
		});

		$('svg').each((_, svg) => {
			throw new Error(`SVG tags are not allowed in ${this.name}.`);
		});

		return {
			path: file.path,
			contents: new Buffer(contents)
		};
	}

	// GitHub heuristics
	private guessBaseUrls(): { content: string; images: string; repository: string} {
		let repository = null;

		if (typeof this.manifest.repository === 'string') {
			repository = this.manifest.repository;
		} else if (this.manifest.repository && typeof this.manifest.repository['url'] === 'string') {
			repository = this.manifest.repository['url'];
		}

		if (!repository) {
			return null;
		}

		const regex = /github\.com\/([^/]+)\/([^/]+)(\/|$)/;
		const match = regex.exec(repository);

		if (!match) {
			return null;
		}

		const account = match[1];
		const repositoryName = match[2].replace(/\.git$/i, '');

		return {
			content: `https://github.com/${account}/${repositoryName}/blob/master`,
			images: `https://github.com/${account}/${repositoryName}/raw/master`,
			repository: `https://github.com/${account}/${repositoryName}`
		};
	}
}

export class ReadmeProcessor extends MarkdownProcessor {

	constructor(manifest: Manifest, options: IPackageOptions = {}) {
		super(manifest, 'README.md', /^extension\/readme.md$/i, 'Microsoft.VisualStudio.Services.Content.Details', options);
	}
}
export class ChangelogProcessor extends MarkdownProcessor {

	constructor(manifest: Manifest, options: IPackageOptions = {}) {
		super(manifest, 'CHANGELOG.md', /^extension\/changelog.md$/i, 'Microsoft.VisualStudio.Services.Content.Changelog', options);
	}
}

class LicenseProcessor extends BaseProcessor {

	private didFindLicense = false;
	private filter: (name: string) => boolean;

	constructor(manifest: Manifest) {
		super(manifest);

		const match = /^SEE LICENSE IN (.*)$/.exec(manifest.license || '');

		if (!match || !match[1]) {
			this.filter = name => /^extension\/license(\.(md|txt))?$/i.test(name);
		} else {
			const regexp = new RegExp('^extension/' + match[1] + '$');
			this.filter = regexp.test.bind(regexp);
		}

		this.vsix.license = null;
	}

	onFile(file: IFile): Promise<IFile> {
		if (!this.didFindLicense) {
			let normalizedPath = util.normalize(file.path);

			if (this.filter(normalizedPath)) {
				if (!path.extname(normalizedPath)) {
					file.path += '.txt';
					normalizedPath += '.txt';
				}

				this.assets.push({ type: 'Microsoft.VisualStudio.Services.Content.License', path: normalizedPath });
				this.vsix.license = normalizedPath;
				this.didFindLicense = true;
			}
		}

		return Promise.resolve(file);
	}
}

class IconProcessor extends BaseProcessor {

	private icon: string;
	private didFindIcon = false;

	constructor(manifest: Manifest) {
		super(manifest);

		this.icon = manifest.icon ? `extension/${manifest.icon}` : null;
		this.vsix.icon = null;
	}

	onFile(file: IFile): Promise<IFile> {
		const normalizedPath = util.normalize(file.path);
		if (normalizedPath === this.icon) {
			this.didFindIcon = true;
			this.assets.push({ type: 'Microsoft.VisualStudio.Services.Icons.Default', path: normalizedPath });
			this.vsix.icon = this.icon;
		}
		return Promise.resolve(file);
	}

	onEnd(): Promise<void> {
		if (this.icon && !this.didFindIcon) {
			return Promise.reject(new Error(`The specified icon '${this.icon}' wasn't found in the extension.`));
		}

		return Promise.resolve(null);
	}
}

export class NLSProcessor extends BaseProcessor {

	private translations: { [path: string]: string } = Object.create(null);

	constructor(manifest: Manifest) {
		super(manifest);

		if (!manifest.contributes || !manifest.contributes.localizations || manifest.contributes.localizations.length === 0) {
			return;
		}

		const localizations = manifest.contributes.localizations;
		const translations: { [languageId: string]: string } = Object.create(null);

		// take last reference in the manifest for any given language
		for (const localization of localizations) {
			for (const translation of localization.translations) {
				if (translation.id === 'vscode' && !!translation.path) {
					const translationPath = util.normalize(translation.path.replace(/^\.[\/\\]/, ''));
					translations[localization.languageId.toUpperCase()] = `extension/${translationPath}`;
				}
			}
		}

		// invert the map for later easier retrieval
		for (const languageId of Object.keys(translations)) {
			this.translations[translations[languageId]] = languageId;
		}
	}

	onFile(file: IFile): Promise<IFile> {
		const normalizedPath = util.normalize(file.path);
		const language = this.translations[normalizedPath];

		if (language) {
			this.assets.push({ type: `Microsoft.VisualStudio.Code.Translation.${language}`, path: normalizedPath });
		}

		return Promise.resolve(file);
	}
}

export function validateManifest(manifest: Manifest): Manifest {
	validatePublisher(manifest.publisher);
	validateExtensionName(manifest.name);

	if (!manifest.version) {
		throw new Error('Manifest missing field: version');
	}

	validateVersion(manifest.version);

	if (!manifest.engines) {
		throw new Error('Manifest missing field: engines');
	}

	if (!manifest.engines['vscode']) {
		throw new Error('Manifest missing field: engines.vscode');
	}

	validateEngineCompatibility(manifest.engines['vscode']);

	if (manifest.devDependencies && manifest.devDependencies['@types/vscode']) {
		validateVSCodeTypesCompatibility(manifest.engines['vscode'], manifest.devDependencies['@types/vscode']);
	}

	if (/\.svg$/i.test(manifest.icon || '')) {
		throw new Error(`SVGs can't be used as icons: ${manifest.icon}`);
	}

	(manifest.badges || []).forEach(badge => {
		const decodedUrl = decodeURI(badge.url);
		const srcUrl = url.parse(decodedUrl);

		if (!/^https:$/i.test(srcUrl.protocol)) {
			throw new Error(`Badge URLs must come from an HTTPS source: ${badge.url}`);
		}

		if (/\.svg$/i.test(srcUrl.pathname) && !isHostTrusted(srcUrl.host)) {
			throw new Error(`Badge SVGs are restricted. Please use other file image formats, such as PNG: ${badge.url}`);
		}
	});

	Object.keys((manifest.dependencies || {})).forEach(dep => {
		if (dep === 'vscode') {
			throw new Error(`You should not depend on 'vscode' in your 'dependencies'. Did you mean to add it to 'devDependencies'?`);
		}
	});

	return manifest;
}

export function readManifest(cwd = process.cwd(), nls = true): Promise<Manifest> {
	const manifestPath = path.join(cwd, 'package.json');
	const manifestNLSPath = path.join(cwd, 'package.nls.json');

	const manifest = readFile(manifestPath, 'utf8')
		.catch(() => Promise.reject(`Extension manifest not found: ${manifestPath}`))
		.then<Manifest>(manifestStr => {
			try {
				return Promise.resolve(JSON.parse(manifestStr));
			} catch (e) {
				return Promise.reject(`Error parsing 'package.json' manifest file: not a valid JSON file.`);
			}
		})
		.then(validateManifest);

	if (!nls) {
		return manifest;
	}

	const manifestNLS = readFile(manifestNLSPath, 'utf8')
		.catch<string>(err => err.code !== 'ENOENT' ? Promise.reject(err) : Promise.resolve('{}'))
		.then<ITranslations>(raw => {
			try {
				return Promise.resolve(JSON.parse(raw));
			} catch (e) {
				return Promise.reject(`Error parsing JSON manifest translations file: ${manifestNLSPath}`);
			}
		});

	return Promise.all([manifest, manifestNLS]).then(([manifest, translations]) => {
		return patchNLS(manifest, translations);
	});

}

export function toVsixManifest(assets: IAsset[], vsix: any, options: IPackageOptions = {}): Promise<string> {
	return readFile(vsixManifestTemplatePath, 'utf8')
		.then(vsixManifestTemplateStr => _.template(vsixManifestTemplateStr))
		.then(vsixManifestTemplate => vsixManifestTemplate(vsix));
}

const defaultExtensions = {
	'.json': 'application/json',
	'.vsixmanifest': 'text/xml'
};

export function toContentTypes(files: IFile[]): Promise<string> {
	const extensions = Object.keys(_.keyBy(files, f => path.extname(f.path).toLowerCase()))
		.filter(e => !!e)
		.reduce((r, e) => ({ ...r, [e]: lookup(e) }), {});

	const allExtensions = { ...extensions, ...defaultExtensions };
	const contentTypes = Object.keys(allExtensions).map(extension => ({
		extension,
		contentType: allExtensions[extension]
	}));

	return readFile(contentTypesTemplatePath, 'utf8')
		.then(contentTypesTemplateStr => _.template(contentTypesTemplateStr))
		.then(contentTypesTemplate => contentTypesTemplate({ contentTypes }));
}

const defaultIgnore = [
	'.vscodeignore',
	'package-lock.json',
	'yarn.lock',
	'.editorconfig',
	'.npmrc',
	'.yarnrc',
	'.gitattributes',
	'*.todo',
	'tslint.yaml',
	'.eslintrc*',
	'.babelrc*',
	'.prettierrc',
	'ISSUE_TEMPLATE.md',
	'CONTRIBUTING.md',
	'PULL_REQUEST_TEMPLATE.md',
	'CODE_OF_CONDUCT.md',
	'.github',
	'.travis.yml',
	'appveyor.yml',
	'**/.git/**',
	'**/*.vsix',
	'**/.DS_Store',
	'**/*.vsixmanifest',
	'**/.vscode-test/**'
];

function collectAllFiles(cwd: string, useYarn = false, dependencyEntryPoints?: string[]): Promise<string[]> {
	return getDependencies(cwd, useYarn, dependencyEntryPoints).then(deps => {
		const promises: Promise<string[]>[] = deps.map(dep => {
			return glob('**', { cwd: dep, nodir: true, dot: true, ignore: 'node_modules/**' })
				.then(files => files
					.map(f => path.relative(cwd, path.join(dep, f)))
					.map(f => f.replace(/\\/g, '/')));
		});

		return Promise.all(promises).then(util.flatten);
	});
}

function collectFiles(cwd: string, useYarn = false, dependencyEntryPoints?: string[]): Promise<string[]> {
	return collectAllFiles(cwd, useYarn, dependencyEntryPoints).then(files => {
		files = files.filter(f => !/\r$/m.test(f));

		return readFile(path.join(cwd, '.vscodeignore'), 'utf8')
			.catch<string>(err => err.code !== 'ENOENT' ? Promise.reject(err) : Promise.resolve(''))

			// Parse raw ignore by splitting output into lines and filtering out empty lines and comments
			.then(rawIgnore => rawIgnore.split(/[\n\r]/).map(s => s.trim()).filter(s => !!s).filter(i => !/^\s*#/.test(i)))

			// Add '/**' to possible folder names
			.then(ignore => [...ignore, ...ignore.filter(i => !/(^|\/)[^/]*\*[^/]*$/.test(i)).map(i => /\/$/.test(i) ? `${i}**` : `${i}/**`)])

			// Combine with default ignore list
			.then(ignore => [...defaultIgnore, ...ignore, '!package.json'])

			// Split into ignore and negate list
			.then(ignore => _.partition(ignore, i => !/^\s*!/.test(i)))
			.then(r => ({ ignore: r[0], negate: r[1] }))

			// Filter out files
			.then(({ ignore, negate }) => files.filter(f => !ignore.some(i => minimatch(f, i, MinimatchOptions)) || negate.some(i => minimatch(f, i.substr(1), MinimatchOptions))));
	});
}

export function processFiles(processors: IProcessor[], files: IFile[], options: IPackageOptions = {}): Promise<IFile[]> {
	const processedFiles = files.map(file => util.chain(file, processors, (file, processor) => processor.onFile(file)));

	return Promise.all(processedFiles).then(files => {
		return util.sequence(processors.map(p => () => p.onEnd())).then(() => {
			const assets = _.flatten(processors.map(p => p.assets));
			const vsix = processors.reduce((r, p) => ({ ...r, ...p.vsix }), { assets });

			return Promise.all([toVsixManifest(assets, vsix, options), toContentTypes(files)]).then(result => {
				return [
					{ path: 'extension.vsixmanifest', contents: new Buffer(result[0], 'utf8') },
					{ path: '[Content_Types].xml', contents: new Buffer(result[1], 'utf8') },
					...files
				];
			});
		});
	});
}

export function createDefaultProcessors(manifest: Manifest, options: IPackageOptions = {}): IProcessor[] {
	return [
		new ManifestProcessor(manifest),
		new TagsProcessor(manifest),
		new ReadmeProcessor(manifest, options),
		new ChangelogProcessor(manifest, options),
		new LicenseProcessor(manifest),
		new IconProcessor(manifest),
		new NLSProcessor(manifest)
	];
}

export function collect(manifest: Manifest, options: IPackageOptions = {}): Promise<IFile[]> {
	const cwd = options.cwd || process.cwd();
	const useYarn = options.useYarn || false;
	const packagedDependencies = options.dependencyEntryPoints || undefined;
	const processors = createDefaultProcessors(manifest, options);

	return collectFiles(cwd, useYarn, packagedDependencies).then(fileNames => {
		const files = fileNames.map(f => ({ path: `extension/${f}`, localPath: path.join(cwd, f) }));

		return processFiles(processors, files, options);
	});
}

function writeVsix(files: IFile[], packagePath: string): Promise<string> {
	return unlink(packagePath)
		.catch(err => err.code !== 'ENOENT' ? Promise.reject(err) : Promise.resolve(null))
		.then(() => new Promise<string>((c, e) => {
			const zip = new yazl.ZipFile();
			files.forEach(f => f.contents ? zip.addBuffer(typeof f.contents === 'string' ? new Buffer(f.contents, 'utf8') : f.contents, f.path) : zip.addFile(f.localPath, f.path));
			zip.end();

			const zipStream = fs.createWriteStream(packagePath);
			zip.outputStream.pipe(zipStream);

			zip.outputStream.once('error', e);
			zipStream.once('error', e);
			zipStream.once('finish', () => c(packagePath));
		}));
}

function defaultPackagePath(cwd: string, manifest: Manifest): string {
	return path.join(cwd, `${manifest.name}-${manifest.version}.vsix`);
}

function prepublish(cwd: string, manifest: Manifest): Promise<Manifest> {
	if (!manifest.scripts || !manifest.scripts['vscode:prepublish']) {
		return Promise.resolve(manifest);
	}

	console.warn(`Executing prepublish script 'npm run vscode:prepublish'...`);

	return exec('npm run vscode:prepublish', { cwd, maxBuffer: 5000 * 1024 })
		.then(({ stdout, stderr }) => {
			process.stdout.write(stdout);
			process.stderr.write(stderr);
			return Promise.resolve(manifest);
		})
		.catch(err => Promise.reject(err.message));
}

export async function pack(options: IPackageOptions = {}): Promise<IPackageResult> {
	const cwd = options.cwd || process.cwd();

	let manifest = await readManifest(cwd);
	manifest = await prepublish(cwd, manifest);

	const files = await collect(manifest, options);
	if (files.length > 100) {
		console.log(`This extension consists of ${files.length} separate files. For performance reasons, you should bundle your extension: https://aka.ms/vscode-bundle-extension. You should also exclude unnecessary files by adding them to your .vscodeignore: https://aka.ms/vscode-vscodeignore`);
	}
	const packagePath = await writeVsix(files, path.resolve(options.packagePath || defaultPackagePath(cwd, manifest)));

	return { manifest, packagePath, files };
}

export async function packageCommand(options: IPackageOptions = {}): Promise<any> {
	const { packagePath, files } = await pack(options);
	const stats = await stat(packagePath);

	let size = 0;
	let unit = '';

	if (stats.size > 1048576) {
		size = Math.round(stats.size / 10485.76) / 100;
		unit = 'MB';
	} else {
		size = Math.round(stats.size / 10.24) / 100;
		unit = 'KB';
	}

	util.log.done(`Packaged: ${packagePath} (${files.length} files, ${size}${unit})`);
}

/**
 * Lists the files included in the extension's package. Does not run prepublish.
 */
export function listFiles(cwd = process.cwd(), useYarn = false, packagedDependencies?: string[]): Promise<string[]> {
	return readManifest(cwd)
		.then(manifest => collectFiles(cwd, useYarn, packagedDependencies));
}

/**
 * Lists the files included in the extension's package. Runs prepublish.
 */
export function ls(cwd = process.cwd(), useYarn = false, packagedDependencies?: string[]): Promise<void> {
	return readManifest(cwd)
		.then(manifest => prepublish(cwd, manifest))
		.then(manifest => collectFiles(cwd, useYarn, packagedDependencies))
		.then(files => files.forEach(f => console.log(`${f}`)));
}
