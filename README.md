# GPX Motion

GPX Motion turns a GPX activity into a smooth 3D terrain animation in a web browser. It draws the completed route behind a moving marker, follows the activity with an animated camera, displays live statistics, and finishes with a bird's-eye overview. Blender is not required.

## Requirements

- Python 3.8 or newer
- A current version of Chrome, Edge, Firefox, or Safari with WebGL 2 support
- An internet connection while preparing satellite imagery, terrain, and map labels
- A Mapbox public access token
- FFmpeg is optional but recommended on Linux for automatic MP4 conversion

## Starting the application

### macOS

1. Double-click `Start GPX Motion - macOS.command`.
2. If macOS blocks the file on the first launch, right-click it, choose **Open**, and confirm.
3. Your default browser opens GPX Motion automatically.

### Windows

1. Copy or extract the complete `GPX_Motion` folder to the computer. Do not start the application from inside a ZIP archive.
2. Install Python 3 from [python.org](https://www.python.org/downloads/). During installation, enable **Add Python to PATH**.
3. Double-click `Start GPX Motion - Windows.bat`.
4. Keep the terminal window open. Your default browser opens GPX Motion automatically.

If the application cannot start, the terminal now remains open and displays the exact error. The most common causes are a missing Python 3 installation or starting only the `.bat` file without the rest of the application folder.

### Linux

1. Install Python 3 with your distribution's package manager.
2. For automatic MP4 output, install FFmpeg with your distribution's package manager. For example, Ubuntu and Debian users can run `sudo apt install ffmpeg`.
3. Run `Start GPX Motion - Linux.sh`. If required, first allow the file to run as a program.
4. Your default browser opens GPX Motion automatically.

Keep the terminal window open while using the application. Close it, or press **Control-C**, when you are finished.

## Basic workflow

1. Select a GPX file.
2. Check the activity title and trim the route if required.
3. Enter your Mapbox access token and choose the visual settings.
4. Select **Prepare 3D map** and wait until the map is ready.
5. Select **Play preview** to review the animation.
6. Select **Export video** to create the final video.

The video is saved in the `out` folder next to the launch files. If local saving is unavailable, the browser downloads the file to its normal Downloads folder. GPX Motion renders an exact number of frames for smooth playback. It exports MP4 directly when the browser supports it. On systems without browser H.264 support, it creates a seekable WebM with proper duration and automatically converts it to H.264 MP4 when FFmpeg is installed. Without FFmpeg, the complete WebM is kept instead.

## Interface guide

### Activity and map

- **GPX activity** selects the `.gpx` file that contains the recorded route.
- **Video title** controls the title displayed in the exported video's heads-up display. The GPX activity name is filled in automatically and can be changed.
- **Mapbox access token** authorizes satellite imagery, terrain, and map data. **Show** reveals or hides the token.
- **Show places, peaks, rivers and lakes** adds useful geographic labels while excluding most shops and other minor points of interest.
- **Show heart rate on heads-up display when available** adds current and average heart rate when the GPX file contains heart-rate samples.

### Trim activity

- The two trim handles remove an unwanted part from the beginning or end of the activity.
- The time range above the slider shows the retained start and end times.
- The line below the slider shows the retained distance and duration.
- Moving a handle immediately updates the 2D route preview. Releasing it updates the prepared 3D view.
- All displayed statistics are recalculated for the retained section.

### Video settings

- **Duration** sets the length of the finished animation in seconds.
- **Resolution** selects 720p, 1080p, or 4K output.
- **FPS** sets the number of video frames per second. Higher values look smoother but require more work.
- **Export format** is selected automatically. FFmpeg enables automatic H.264 MP4 conversion on systems whose browser can only encode WebM.
- **Render quality** controls map detail and rendering load:
  - **Fast** uses the least memory and prepares the quickest.
  - **Balanced** is the recommended default.
  - **Best** uses a sharper internal map render and more route color segments.
- **Movement metric** selects automatic detection, running pace in min/km, or cycling speed in km/h.
- **Video format** selects horizontal 16:9 or vertical 9:16 video.

### Route appearance

- **Route coloring** uses either one chosen color or a red-to-green scale based on relative speed along the activity.
- **Route and marker color** selects the shared color of the single-color route and moving marker. At the finish, the marker becomes a black-and-white checkered circle.

### Heads-up display, labels, and camera

- **Heads-up display distance from top** moves the title and activity statistics closer to or farther from the top edge.
- **Heads-up display font size** scales the title and statistics.
- **Map label font size** scales place, peak, river, and lake labels.
- **Camera distance** controls how far the camera follows behind the moving marker. `1.0x` is the default.
- **Camera height** controls the camera's height and viewing angle. A larger value creates a higher, more overhead view.

The camera smooths normal turns, adapts to rugged terrain, and uses a safer view during sustained descents. At the end, it moves to a bird's-eye view that keeps the complete selected route visible.

### Actions and status

- **Prepare 3D map** loads the required map and terrain tiles and builds the animation.
- **Play preview** starts the live preview. The same button becomes **Stop** during playback.
- **Export video** records the prepared animation to a video file.
- **Stop** cancels an active export and discards the unfinished file.
- **Frame** shows the current frame and total frame count during export.
- The progress bar and status text report map preparation and video export progress.

## Data, settings, and cache

- The GPX file is processed locally in the browser and is not uploaded as a file.
- The Mapbox token and the most recent interface settings are stored locally in `app/settings.json`.
- Downloaded satellite, elevation, and label tiles are kept in a limited browser cache. Preparing the same area again is therefore faster and more reliable.
- The first preparation of a new route can take longer because GPX Motion preloads the map tiles needed by the camera animation.
- The route remains close to the terrain while receiving additional visibility protection on steep slopes.
