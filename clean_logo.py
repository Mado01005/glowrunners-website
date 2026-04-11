from PIL import Image

def clean_logo(input_path, output_path):
    img = Image.open(input_path).convert("RGBA")
    datas = img.getdata()

    newData = []
    for item in datas:
        # If near white, make transparent
        if item[0] > 245 and item[1] > 245 and item[2] > 245:
            newData.append((255, 255, 255, 0))
        else:
            newData.append(item)

    img.putdata(newData)
    
    # Trim the image (autocrop) using the alpha channel
    # getbbox() works on images with an alpha channel too
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
        
    img.save(output_path, "PNG")

if __name__ == "__main__":
    clean_logo("/Users/abdallahsaad/.gemini/antigravity/brain/1aead66e-033d-4573-afb6-73c6f0fd6c1d/glowrunners_logo_white_bg_1775928475847.png", "/Users/abdallahsaad/.gemini/antigravity/scratch/glowrunners-website/assets/logo.png")
    print("Logo successfully cleaned and saved.")
