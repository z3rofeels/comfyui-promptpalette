<img width="1792" height="592" alt="PromptP" src="https://github.com/user-attachments/assets/fd7f965d-f593-4d7a-b65f-32be38219650" />


Prompt Palette for ComfyUI! Your new best friend when it comes to prompting in ComfyUI.

Prompt Palette takes your boring wall of messy text and let's you quickly visualize what's in your prompt, by color. Fully customizable to your taste, wildcards or not, bright or light, use it how you want and change it depending on your mood.

🐝🐝🟢***SKIP THE TEXT WALL AND SCROLL DOWN TO SEE IT FOR YOURSELF OR INSTALL RIGHT AWAY***🟢🐝🐝

## Installation

1. Clone this repo into `ComfyUI/custom_nodes/`.
2. Restart ComfyUI.
3. Drop your files into `ComfyUI/wildcards/`.

_______________________________________________________________________________
## Features 🌟

**Auto Hue Shifting: Dynamically change the look of your text prompt.**

**Brightness & Font Controls: Fine-tune the UI with a brightness slider, font picker, and font size slider.** 

**Smart Organization: Use star-to-pin, recents lists, and collapsible categories to keep your workflow tidy.**  

**Drag-and-Drop: Easily reorganize your library with drag-and-drop functionality.**  

**In-Node Editing: Edit wildcards directly without leaving your graph.** 

**Custom Themes: Fully themeable UI with support for easy JSON-based (Derulo/Statham/Bateman) configuration.**  

***Check it out!*** 

<img width="211" height="535" alt="promptpalcats" src="https://github.com/user-attachments/assets/fd7e4a3e-e209-4288-9f65-1083aa6c1849" />


______________________________________________________________________________



🔴**Visually find what's in your prompt with color coded categories, click "show resolved" to show the actual text.**

https://github.com/user-attachments/assets/c8bf1308-762e-4877-a296-3b0f79da7f29

🟡**Color shift hues and make it brighter or lighter!** 

https://github.com/user-attachments/assets/a90d292a-aa9e-4d5f-ad39-cf236ef8f978

🔵🟢🟠🟣**Themeable! Custom themes and a font selector, as well.**

https://github.com/user-attachments/assets/93280fd8-feea-4e8e-a003-4e612daa5295


https://github.com/user-attachments/assets/50cbffb8-40a9-4ba3-b083-0097b0367d6d


https://github.com/user-attachments/assets/db11cd61-6b61-4e8a-a390-7c3e98691fe2

https://github.com/user-attachments/assets/a0ac9372-30ae-48aa-ba52-8243716d545a




<img width="252" height="382" alt="insandouts" src="https://github.com/user-attachments/assets/d699875b-bf89-4a15-b72f-67676ec80d9f" />

<img width="205" height="457" alt="catcolsuserpicks" src="https://github.com/user-attachments/assets/b97f1397-857a-4302-9c9a-c33703a70cff" />

<img width="1041" height="403" alt="hoverview1" src="https://github.com/user-attachments/assets/8bac4e9e-a3c3-4dfe-a813-420522857fa6" />

<img width="559" height="1109" alt="fontpickerfirefox" src="https://github.com/user-attachments/assets/19f51eb7-0107-4901-81c3-db2b5f964972" />

<img width="372" height="530" alt="fontselectorchrome" src="https://github.com/user-attachments/assets/227fb5b3-c371-4f0d-89a8-667b56881688" />


<img width="948" height="402" alt="hoverview" src="https://github.com/user-attachments/assets/5d871311-1cef-45df-a8cc-d75908f12dd3" />


<img width="254" height="868" alt="themes" src="https://github.com/user-attachments/assets/1160fbf3-2143-48b0-8fe7-8b88343da3a0" />


### Editor
* **Color-coded text box:** Wildcards and choice syntax are auto-highlighted.
* **Double-click:** Edit wildcards directly in the panel.

### Library Management
* **Slide-out panel:** Browse, organize, and drag-and-drop wildcards.
* **Search:** Search across your whole library.




**Advanced Syntax**

Write your prompts using the powerful syntax recognized by the node:

    __name__: Random line from name.txt (Seeded)

    __*name__: Random line (Unseeded—always different)

    __+name__: Sequential (Cycles through the list)

    {a|b|c}: Random choice between options

    {2$$, $$a|b|c}: Multi-select: Pick 2 items, joined by commas

    {3::a|1::b|c}: Weighted choice (Heavier probability on 'a')

    Note: Nesting is fully supported! You can put a {choice} inside a __wildcard__ and it will resolve perfectly.
    









