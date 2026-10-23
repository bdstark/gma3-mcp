/**
 * grandMA3 command keywords, by the names the console writes them in a stored command line ("Go+", "Sequence",
 * "ClearAll"). From the keyword pages of the onPC user manual (keyword_*.html, 2.4.2 to 2.5.1; GoFastForward and
 * GoFastBackward are titled by their symbols there); the symbol keywords (+, -, ;, /, ...) are left out.
 */
export const COMMAND_KEYWORDS: ReadonlySet<string> = new Set(
  `
  Absolute Acceleration Action ActivationGroup Agenda Align AlignTransition Appearance Assign At Attribute
  AutoCreate AutoStore Bitmap Black Blind Block BPM Call Camera CancelSoftwareUpdate Capture ChangeDestination
  ChangeMulticastBase Channel ChannelFunctionDefault ChannelSet Chat ChatJoin ChatLeave CleanUp Clear ClearActive
  ClearAll ClearSelection Clone Collect Collection Color ColorDefinition ColorTheme CommandDelay Configuration
  Console Cook Copy CopyCrashLog Cue CueAbsolute CueDelay CueFade CueInDelay CueInFade CueOutDelay CueOutFade
  CueRelative CueUpdate CurrentEnvironment CurrentUser CurrentUserProfile Cut DataPool Deactivate Deceleration
  Decimal16 Decimal24 Decimal8 Default Delay Delete DeleteGlobalVariable DeleteOtherVersion DeleteUserVariable
  Disconnect Dismiss Display DMXAddress DMXLayer DMXReadout DMXUniverse DoubleSpeed Down Drive DropOwnership
  DumpLog Echo Edit EditRecipe EditSetting Effect Eject EncoderBank EncoderBar EndIf Environment Exchange
  Executor Export Extension Extract Fade FaderCrossFade FaderCrossFadeA FaderCrossFadeB FaderMaster FaderRate
  FaderSpeed FaderTemp FaderTime FastSync FeatureGroup Filter Fix Fixture FixtureClass FixtureLayer FixtureType
  Flash Flip Fog Freeze Full Gel Generator Generic GetGlobalVariable GetUserVariable Go+ Go- GoboImage Goto Grid
  GridPosition GridStore Group HalfSpeed Help HelpKeyword HelpLua Hex16 Hex24 Hex8 Highlight Hold Houselights Hz
  If IfActive IfOutput IfProgrammer Image Import Index Insert Integrate Interface Invert Invite IP JoinSession
  Key Keyboard KeyboardShortcut Kill KnockIn KnockOut Label Layout Learn LearnSpeed LeaveSession Library List
  ListCrashLog ListOwnership ListReference Load Loaded LoadShow Locate Lock LogIn LogOut Lowlight Lua LuaFile
  Macro MArker Master MAtricks Measure Media MemoryInfo Menu Mesh MessageCenter Move Multipatch MyRunningMacro
  MyRunningPlayback MyRunningPreset MyRunningSequence MyRunningSoundFile MyRunningTimecode MyRunningTimer Natural
  NDI NetworkNode NetworkSpeedTest NewShow Next NextY NextZ NonDim Normal Note NShot Off Offset On onPC Oops OSC
  OutputLayer Page Park Part Paste Patch Pause Percent PercentFine Phase Physical Plugin Preset PresetUpdate
  Press Preview Previous PreviousY PreviousZ ProcessingUnit Programmer Property PSR Pyro Quickey Rate1 RDM
  Readout RealtimeChannel Reboot Recast Reconnect Record Relative Release ReloadAllPlugins ReloadUI Remote
  RemoteCommand RemoteHID Remove RenderQuality Reset Restart ReSync Root RunningMacro RunningPlayback
  RunningPreset RunningSequence RunningSoundFile RunningTimecode RunningTimer SaveShow ScreenConfiguration
  ScreenContent Scribble Seconds Select SelectFixtures Selection SendMIDI SendMVR SendOSC Sequence Session Set
  SetGlobalVariable SetUserVariable Shape Shuffle ShutDown SnapDelay SoftwareImport SoftwareUpdate Solo Sound
  SoundChannel SpecialExecutor Speed Speed1 SpeedMaster Stage Station StationSettings Step Stomp Store Swap
  SwitchTograndMA2Software SwitchTograndMA3Software Tag Temp Thru Time Timecode TimecodeSlot Timer Toggle Top
  TopUp Transition Type UIChannel UIGridSelection Unblock Unlock Unpark Unpress Up Update UpdateContent User
  User1 User2 UserProfile Version Video View ViewButton Width World Zero
  GoFastBackward GoFastForward
`
    .trim()
    .split(/\s+/)
    .map((k) => k.toLowerCase()),
);
