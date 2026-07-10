<img width="1856" height="576" alt="palbanner" src="https://github.com/user-attachments/assets/475b8530-cd4d-4a5b-a517-3c72b54111f7" />


``
      
                                           (This page looks better in dark mode for now, oops) 🤷‍♂️

     recent updates: Resizeable side panel (woo)
     Type double underscore for a mini hover menu for quick access (heck yeah)
     clear button for recents (duh)
     optional day/night toggle (or choose your own theme for day/night options)((heck yeahx2))
     Cleaning up toolbar and making more options...optional (cause' why not)

    *
``





##

$${\color{lightblue}\text{Your }}{\color{green}\text{new}}{\color{blue}\text{ best friend for prompting in ComfyUI.}}$$

$${\color{blue}\text{Prompt Palette}}{\color{lavender}\text{ instantly brings your prompts to life with beautiful, }}{\color{cyan}\text{color-coded visualization.}}$$

$${\color{red}\text{Fully customizable: }}{\color{orange}\text{wildcards}}{\color{lavender}\text{ or plain text, vibrant or subtle themes, }}{\color{white}\text{light}}{\color{lavender}\text{ or }}{\color{darkgray}\text{dark}}{\color{lavender}\text{ modes.}}$$

$${\color{red}\text{Adapt }}{\color{orange}\text{it }} {to}  {\color{blue}\text{your }}{\color{yellow}\text{workflow }}{\color{blue}\text{and }}{\color{purple}\text{change }}{\color{grey}\text{the }}{\color{lightsalmon}\text{look }}{\color{aquamarine}\text{whenever }}{\color{lime}\text{the }}{\color{lightblue}\text{mood }}{\color{lightgreen}\text{strikes.}}$$

##


 $${\color{lightblue}\text{Features }}$$

<img width="1583" height="1017" alt="showresolved" src="https://github.com/user-attachments/assets/e7d0cd39-de4c-4fe0-8c20-bcf02837b8d7" />


🟢 Editor
* **Color-coded text box:** Wildcards and choice syntax are auto-highlighted.
* **Double-click:** Edit wildcards directly in the panel.

  <img width="1535" height="1037" alt="ppalv2" src="https://github.com/user-attachments/assets/8e3f589c-cbf1-4ef7-a20a-c893ceb68b92" />

💡 Tip: Click "Show resolved" to view the expanded text.

<img width="1671" height="941" alt="chrome_19rgnGkG2t" src="https://github.com/user-attachments/assets/ee5c6753-5415-4271-a7dc-efc419cfcdf1" />

**Wildcard prompt resolver extra functions (YOU DO NOT HAVE TO USE THESE IF YOU DON'T WANT - everything is optional!)**

```text
Supports:
  __name__                 -> random line from wildcards/name.txt (or yaml leaf), seeded
  __*name__                -> random line, always unseeded (varies every run)
  __+name__                -> sequential line, increments one step per call
  __-name__                -> sequential line, decrements one step per call
  {a|b|c}                  -> random choice, seeded
  {*a|b|c}                 -> random choice, unseeded
  {+a|b|c}                 -> sequential choice, increments one step per call
  {-a|b|c}                 -> sequential choice, decrements one step per call
  {N::a|M::b|c}            -> weighted choice
  {n$$sep$$a|b|c}           -> select n items joined by sep
  {n-m$$sep$$a|b|c}         -> select between n and m items joined by sep
  {n#__wc__}                -> repeat wildcard n times (expands before multi-select)
  # comment                -> ignored (line-leading only)

Nesting is resolved innermost-first over several passes.
```







🟢Library Management:
$${\color{red}\text{In-Node Editing: Edit wildcards directly without leaving your graph.}}$$

$${\color{yellow}\text{Smart Organization: Use star-to-pin, recents lists, and collapsible categories to keep your workflow tidy.}}$$

$${\color{orange}\text{Slide-out panel: Browse, organize, and drag-and-drop categories for easy organizing.}}$$

$${\color{blue}\text{Search: Search across your whole collection.}}$$


**Optional Light/Dark mode** 
<img width="1810" height="975" alt="optionaldaynight" src="https://github.com/user-attachments/assets/2e88cf49-00bc-4a48-a8e5-bd0953ddd999" />
<img width="1273" height="835" alt="ppalv2b" src="https://github.com/user-attachments/assets/230339a0-30f1-4f38-ab6f-545914f0c4f2" />



🟡**Color shift hues and make it brighter or lighter!** 

$${\large\bf\color{red}\text{Auto }}{\large\bf\color{blue}\text{Hue }}{\large\bf\color{yellow}\text{Shifting: }}{\large\color{lightgray}\text{Dynamically change the look of your text prompt.}}$$

$${\large\bf\color{white}\text{Brightness and Font Controls: }}{\large\color{gray}\text{Fine-tune the UI with a brightness slider, font picker, and font size slider.}}$$


<img width="1208" height="763" alt="hue shiftv1" src="https://github.com/user-attachments/assets/a0a696a1-fbfc-450b-bbf2-74394294c1fb" />































***UPDATING SECTION WITH MORE DEMOS SOON***








🏁 Installation

    Clone this repo into your ComfyUI/custom_nodes/ folder OR simply drag and drop the folder into /custom_nodes/.

    Restart ComfyUI.

    (Optional but recommended) Drop your wildcard files into ComfyUI/wildcards/.

    ⚠️ Important Note for ZIP Users

    If you downloaded the repository using GitHub’s “Download ZIP” button:

        Extract the ZIP file into your ComfyUI/custom_nodes/ directory.

        Rename the extracted folder from comfyui-promptpalette-main to exactly comfyui-promptpalette.

        If the folder isn’t renamed correctly, the node will fail to load.

















