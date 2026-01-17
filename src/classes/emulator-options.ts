import { getGlobalOptions } from '../libs/options.ts'
import { generateValidFileName, getResult, merge } from '../libs/utils.ts'
import type { NostalgistOptions } from '../types/nostalgist-options.ts'
import type { RetroArchEmscriptenModuleOptions } from '../types/retroarch-emscripten.ts'
import { ResolvableFile } from './resolvable-file.ts'

// Copied from https://github.com/sindresorhus/is-plain-obj/blob/main/index.js
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) &&
    !(Symbol.toStringTag in value) &&
    !(Symbol.iterator in value)
  )
}

type CacheKey = Record<string, unknown> | string
type CacheField = 'bios' | 'core' | 'rom' | 'shader' | 'sram' | 'state'

function isValidCacheKey(cacheKey: unknown): cacheKey is CacheKey {
  return typeof cacheKey === 'string' || isPlainObject(cacheKey)
}

function normalizeSramTypes(value?: string | string[]) {
  if (!value) {
    return
  }
  return Array.isArray(value) ? value : [value]
}

function getCacheStore(): Record<CacheField, Map<CacheKey, unknown>> {
  return {
    bios: new Map<CacheKey, unknown>(),
    core: new Map<CacheKey, unknown>(),
    rom: new Map<CacheKey, unknown>(),
    shader: new Map<CacheKey, unknown>(),
    sram: new Map<CacheKey, unknown>(),
    state: new Map<CacheKey, unknown>(),
  }
}

export class EmulatorOptions {
  static readonly cacheStorage = getCacheStore()
  beforeLaunch?: (() => Promise<void> | void) | undefined
  bios: ResolvableFile[] = []
  cache = { bios: false, core: false, rom: false, shader: false, sram: false, state: false }
  core: {
    /** the name of core */
    name: string

    /** the core's resolvable js file */
    js: ResolvableFile

    /** the core's resolvable wasm file */
    wasm: ResolvableFile
  } = {} as any
  element: HTMLCanvasElement
  /**
   * An option to override the `Module` object for Emscripten. See [Module object](https://emscripten.org/docs/api_reference/module.html).
   *
   * This is a low level option and not well tested, so use it at your own risk.
   */
  emscriptenModule: RetroArchEmscriptenModuleOptions
  respondToGlobalEvents: boolean
  rom: ResolvableFile[] = []
  runMainArgs?: NostalgistOptions['runMainArgs']
  shader: ResolvableFile[] = []
  signal?: AbortSignal | undefined
  /**
   *
   * The size of the canvas element.
   * If it's `'auto'`, the canvas element will keep its original size, or it's width and height will be updated as specified.
   */
  size?: 'auto' | { height: number; width: number }

  sram: ResolvableFile | undefined = undefined

  sramFiles: ResolvableFile[] | undefined = undefined

  sramType: string | undefined = undefined

  sramTypes: string[] | undefined = undefined

  state: ResolvableFile | undefined = undefined

  waitForInteraction: ((params: { done: () => void }) => void) | undefined

  /**
   * RetroArch config.
   * Not all options can make effects in browser.
   */
  get retroarchConfig() {
    const options = {}
    merge(options, getGlobalOptions().retroarchConfig, this.nostalgistOptions.retroarchConfig)
    return options as typeof this.nostalgistOptions.retroarchConfig
  }

  /**
   * RetroArch core config.
   * Not all options can make effects in browser.
   */
  get retroarchCoreConfig() {
    const options = {}
    merge(options, getGlobalOptions().retroarchCoreConfig, this.nostalgistOptions.retroarchCoreConfig)
    return options as typeof this.nostalgistOptions.retroarchCoreConfig
  }

  get style() {
    const { element, style } = this.nostalgistOptions
    const defaultAppearanceStyle: Partial<CSSStyleDeclaration> = {
      backgroundColor: 'black',
      imageRendering: 'pixelated',
    }

    if (element) {
      merge(defaultAppearanceStyle, style)
      return defaultAppearanceStyle
    }

    const defaultLayoutStyle: Partial<CSSStyleDeclaration> = {
      height: '100%',
      left: '0',
      position: 'fixed',
      top: '0',
      width: '100%',
      zIndex: '1',
    }
    merge(defaultLayoutStyle, defaultAppearanceStyle, style)
    return defaultLayoutStyle
  }

  private loadPromises: Promise<void>[] = []

  private nostalgistOptions: NostalgistOptions

  private constructor(options: NostalgistOptions) {
    this.nostalgistOptions = options

    this.emscriptenModule = options.emscriptenModule ?? {}
    this.respondToGlobalEvents = options.respondToGlobalEvents ?? true
    this.runMainArgs = options.runMainArgs
    this.signal = options.signal
    this.size = options.size ?? 'auto'
    this.sramTypes = normalizeSramTypes(options.sramTypes)
    this.sramType = this.sramTypes?.[0] ?? options.sramType ?? 'srm'
    // eslint-disable-next-line sonarjs/deprecation
    this.waitForInteraction = options.waitForInteraction
    this.element = this.getElement()

    if (typeof options.cache === 'boolean') {
      for (const key in this.cache) {
        this.cache[key as keyof typeof this.cache] = options.cache
      }
    } else {
      Object.assign(this.cache, options.cache)
    }
  }

  static async create(options: NostalgistOptions) {
    const emulatorOptions = new EmulatorOptions(options)
    await emulatorOptions.load()
    return emulatorOptions
  }

  static resetCacheStore() {
    Object.assign(EmulatorOptions.cacheStorage, getCacheStore())
  }

  async load() {
    this.loadFromCache()
    await Promise.all(this.loadPromises)
    this.saveToCache()
  }

  loadFromCache() {
    const loadPromises: Promise<void>[] = []
    const loadMethodMap = {
      bios: this.updateBios,
      core: this.updateCore,
      rom: this.updateRom,
      shader: this.updateShader,
      sram: this.updateSRAM,
      state: this.updateState,
    }
    for (const key in this.cache) {
      const field = key as keyof typeof this.cache
      const cachedValue = this.getCachedValue(field)
      if (cachedValue) {
        this[field] = cachedValue as any
        continue
      }
      const method = loadMethodMap[field]
      const promise = method.call(this)
      loadPromises.push(promise)
    }
    this.loadPromises = loadPromises
  }

  saveToCache() {
    for (const key in this.cache) {
      const field = key as keyof typeof this.cache
      if (!this.cache[field]) {
        continue
      }
      const cacheKey = this.getCacheKey(field)
      const cacheValue: any = this[field]
      if (isValidCacheKey(cacheKey) && cacheValue) {
        EmulatorOptions.cacheStorage[field].set(cacheKey, cacheValue)
      }
    }
  }

  async updateSRAM() {
    let sramInput = this.getSramInput()
    if (!sramInput) {
      return
    }
    sramInput = await getResult(sramInput)
    if (!sramInput) {
      return
    }

    const rawFiles = Array.isArray(sramInput) ? sramInput : [sramInput]
    const resolvedFiles = await Promise.all(rawFiles.map((raw) => ResolvableFile.create(raw)))
    if (this.nostalgistOptions.sramFiles || rawFiles.length > 1) {
      this.sramFiles = resolvedFiles
      this.sram = undefined
    } else {
      this.sram = resolvedFiles[0]
    }
  }

  async updateState() {
    if (this.nostalgistOptions.state) {
      this.state = await ResolvableFile.create(this.nostalgistOptions.state)
    }
  }

  private getCachedValue(field: keyof typeof this.cache) {
    if (!this.cache[field]) {
      return
    }
    const cacheKey = this.getCacheKey(field)
    if (!isValidCacheKey(cacheKey)) {
      return
    }
    return EmulatorOptions.cacheStorage[field].get(cacheKey)
  }

  private getCacheKey(field: keyof typeof this.cache) {
    if (field === 'rom') {
      return this.getRomInput()
    }
    if (field === 'sram') {
      return this.getSramInput()
    }
    return this.nostalgistOptions[field]
  }

  private getElement() {
    if (typeof document !== 'object') {
      throw new TypeError('document must be an object')
    }
    let { element } = this.nostalgistOptions
    if (typeof element === 'string' && element) {
      const canvas = document.body.querySelector(element)
      if (!canvas) {
        throw new Error(`can not find element "${element}"`)
      }
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new TypeError(`element "${element}" is not a canvas element`)
      }
      element = canvas
    }
    if (!element) {
      element = document.createElement('canvas')
    }

    if (element instanceof HTMLCanvasElement) {
      element.id = 'canvas'
      return element
    }

    throw new TypeError('invalid element')
  }

  private getRomInput() {
    return this.nostalgistOptions.roms ?? this.nostalgistOptions.rom
  }

  private getSramInput() {
    return this.nostalgistOptions.sramFiles ?? this.nostalgistOptions.sram
  }

  private async updateBios() {
    let { bios, resolveBios } = this.nostalgistOptions
    if (!bios) {
      return
    }
    bios = await getResult(bios)
    if (!bios) {
      return
    }

    const biosFiles = Array.isArray(bios) ? bios : [bios]
    this.bios = await Promise.all(
      biosFiles.map((raw) =>
        ResolvableFile.create(
          typeof raw === 'string'
            ? { raw, signal: this.signal, urlResolver: () => resolveBios(raw, this.nostalgistOptions) }
            : { raw, signal: this.signal },
        ),
      ),
    )
  }

  private async updateCore() {
    const { core, resolveCoreJs, resolveCoreWasm } = this.nostalgistOptions

    if (typeof core === 'object' && 'js' in core && 'name' in core && 'wasm' in core) {
      const [js, wasm] = await Promise.all([ResolvableFile.create(core.js), ResolvableFile.create(core.wasm)])
      this.core = { js, name: core.name, wasm }
      return
    }

    const [coreResolvable, coreWasmResolvable] = await Promise.all(
      [resolveCoreJs, resolveCoreWasm].map((resolver) =>
        ResolvableFile.create({
          raw: core,
          signal: this.signal,
          urlResolver: () => resolver(core, this.nostalgistOptions),
        }),
      ),
    )

    const name = typeof core === 'string' ? core : coreResolvable.name

    this.core = { js: coreResolvable, name, wasm: coreWasmResolvable }
  }

  private async updateRom() {
    const { resolveRom } = this.nostalgistOptions
    let rom = this.getRomInput()
    if (!rom) {
      return
    }
    rom = await getResult(rom)
    if (!rom) {
      return
    }

    const romFiles = Array.isArray(rom) ? rom : [rom]

    this.rom = await Promise.all(
      romFiles.map((romFile) =>
        ResolvableFile.create(
          typeof romFile === 'string'
            ? { raw: romFile, signal: this.signal, urlResolver: () => resolveRom(romFile, this.nostalgistOptions) }
            : { raw: romFile, signal: this.signal },
        ),
      ),
    )
    for (const resolvable of this.rom) {
      resolvable.name ||= generateValidFileName()
    }
  }

  private async updateShader() {
    let { resolveShader, shader } = this.nostalgistOptions
    if (!shader) {
      return
    }
    shader = await getResult(shader)
    if (!shader) {
      return
    }

    let rawShaderFile = await resolveShader(shader, this.nostalgistOptions)
    if (!rawShaderFile) {
      return
    }
    rawShaderFile = await getResult(rawShaderFile)
    if (!rawShaderFile) {
      return
    }

    const rawShaderFiles = Array.isArray(rawShaderFile) ? rawShaderFile : [rawShaderFile]
    this.shader = await Promise.all(
      rawShaderFiles.map((rawShaderFile) => ResolvableFile.create({ raw: rawShaderFile, signal: this.signal })),
    )
  }
}
